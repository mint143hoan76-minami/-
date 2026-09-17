const MODEL = "gemini-3.6-flash";

async function callGemini(promptText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw Object.assign(
      new Error(
        "GEMINI_API_KEY가 설정되지 않았습니다. .env 파일에 키를 추가한 뒤 서버를 다시 시작하세요."
      ),
      { status: 501 }
    );
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        // Gemini가 마크다운 코드펜스 없이 순수 JSON만 반환하도록 강제합니다.
        generationConfig: { responseMimeType: "application/json" },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(
      new Error(`Gemini API 오류 (${res.status}): ${body.slice(0, 300)}`),
      { status: 502 }
    );
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason;
    throw Object.assign(
      new Error(
        `AI 응답에서 텍스트를 찾지 못했습니다.${reason ? ` (사유: ${reason})` : ""}`
      ),
      { status: 502 }
    );
  }
  return text;
}

// responseMimeType을 지정해도 만약을 대비해 관대하게 파싱합니다.
function parseJsonLoose(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[{[]/);
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  const slice = start >= 0 && end >= 0 ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(slice);
}

async function generateDraftJson(promptText) {
  const text = await callGemini(promptText);
  try {
    return parseJsonLoose(text);
  } catch (e) {
    throw Object.assign(
      new Error("AI 응답을 JSON으로 해석하지 못했습니다. 다시 시도해 주세요."),
      { status: 502 }
    );
  }
}

// 스크래핑으로 확인된 상품명/설명만 근거로 키워드·강조 포인트 후보를 제안합니다.
// (없는 사실을 만들어내지 않도록 상품 정보 외 다른 입력은 주지 않습니다.)
async function suggestKeywords(productName, productDesc) {
  const prompt = `다음은 실제로 확인된 상품 정보입니다. 이 안의 내용만 근거로 핵심 키워드 후보와 강조 포인트 후보를 추출하세요. 정보에 없는 내용을 추측해서 만들지 마세요.

상품명: ${productName || ""}
상품 설명: ${productDesc || ""}

다음 JSON 형식으로만 답하세요:
{"keywords":["핵심 키워드 후보 최대 5개"],"highlights":["강조할 만한 확인된 포인트 후보 최대 5개"]}`;
  const text = await callGemini(prompt);
  return parseJsonLoose(text);
}

// 자동 접속이 막힌 상품 페이지용: 사용자가 직접 자기 브라우저로 열어서
// 복사해 붙여넣은 원문 텍스트에서 상품 정보를 정리합니다.
async function extractFromPaste(rawText) {
  const snippet = (rawText || "").slice(0, 6000);
  const prompt = `다음은 사용자가 어떤 쇼핑 상품 페이지에서 직접 복사해 붙여넣은 텍스트입니다. 이 안에 실제로 있는 정보만 사용해서 아래 항목을 추출하세요. 없는 내용을 추측해서 만들지 마세요.

[붙여넣은 내용]
${snippet}

다음 JSON 형식으로만 답하세요:
{"productName":"상품명 (확인 안 되면 빈 문자열)","productDesc":"확인된 설명·구성·규격을 300자 이내로 요약 (광고 문구·과장 표현 제외)","keywords":["핵심 키워드 후보 최대 5개"],"highlights":["강조할 만한 확인된 포인트 후보 최대 5개"]}`;
  const text = await callGemini(prompt);
  return parseJsonLoose(text);
}

// 자동 접속이 막힌 상품 페이지용: 사용자가 직접 찍거나 캡처한 스크린샷 이미지에서
// 상품 정보를 정리합니다. Gemini의 이미지 인식(멀티모달) 기능을 사용합니다.
async function extractFromImage(base64Data, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw Object.assign(
      new Error(
        "GEMINI_API_KEY가 설정되지 않았습니다. .env 파일에 키를 추가한 뒤 서버를 다시 시작하세요."
      ),
      { status: 501 }
    );
  }
  const prompt = `이 이미지는 어떤 쇼핑 상품 페이지의 스크린샷입니다. 이미지 안에서 실제로 보이는 정보만 사용해서 아래 항목을 추출하세요. 이미지에 없는 내용을 추측해서 만들지 마세요.

다음 JSON 형식으로만 답하세요:
{"productName":"상품명 (확인 안 되면 빈 문자열)","productDesc":"확인된 설명·구성·규격을 300자 이내로 요약 (광고 문구·과장 표현 제외)","keywords":["핵심 키워드 후보 최대 5개"],"highlights":["강조할 만한 확인된 포인트 후보 최대 5개"]}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inlineData: { mimeType: mimeType || "image/jpeg", data: base64Data } },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json" },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(
      new Error(`Gemini API 오류 (${res.status}): ${body.slice(0, 300)}`),
      { status: 502 }
    );
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw Object.assign(new Error("이미지에서 정보를 읽지 못했습니다."), { status: 502 });
  }
  return parseJsonLoose(text);
}

module.exports = { generateDraftJson, suggestKeywords, extractFromPaste, extractFromImage };
