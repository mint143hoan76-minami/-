// 주 모델이 과부하(503)나 할당량 초과(429)로 막히면, 대체 모델로 자동 전환합니다.
// gemini-2.5-flash는 신규 사용자에게 더 이상 제공되지 않아(404) 제외했고,
// 대신 별도 할당량 풀을 쓰는 경량 모델(flash-lite)을 대체로 둡니다.
const MODELS = ["gemini-3.6-flash", "gemini-3.5-flash-lite"];

const MAX_RETRIES_PER_MODEL = 2;
const RETRY_DELAYS_MS = [1200, 2500];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOverloaded(status, bodyText) {
  if (status === 503) return true;
  return typeof bodyText === "string" && bodyText.includes("UNAVAILABLE");
}

async function callGeminiRaw(model, requestBody, apiKey) {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
    }
  );
}

// requestBody(contents 등)를 받아 Gemini를 호출합니다.
// - 503(일시 과부하): 같은 모델로 잠깐 쉬었다 재시도하고, 그래도 안 되면 다음 모델로.
// - 429(할당량 초과): 같은 모델로 재시도해도 소용없으므로(할당량이 그 자리에서
//   다시 차지 않음) 바로 다음 모델로 넘어갑니다. 무료 요금제는 보통 모델별로
//   할당량이 따로 계산되기 때문에, 한 모델이 다 찼어도 다른 모델은 남아있을 수 있습니다.
// 모든 모델이 다 막히면 마지막 오류를 그대로 던집니다 (거짓으로 성공한 척하지 않음).
async function callGeminiWithRetry(requestBody, apiKey) {
  let lastError;
  for (let m = 0; m < MODELS.length; m++) {
    const model = MODELS[m];
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      const res = await callGeminiRaw(model, requestBody, apiKey);
      if (res.ok) {
        return res.json();
      }
      const body = await res.text().catch(() => "");

      if (isOverloaded(res.status, body)) {
        if (attempt < MAX_RETRIES_PER_MODEL) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        // 이 모델은 재시도를 다 썼습니다 — 다음 모델로 넘어갑니다.
        lastError = Object.assign(
          new Error(`Gemini API 오류 (${res.status}): ${body.slice(0, 300)}`),
          { status: 503 }
        );
        break;
      }

      if (res.status === 429) {
        // 할당량 초과는 기다린다고 풀리지 않으므로, 재시도 없이 바로 다음 모델로.
        lastError = Object.assign(
          new Error(`Gemini API 오류 (429): ${body.slice(0, 300)}`),
          { status: 429 }
        );
        break;
      }

      if (res.status === 404) {
        // 이 모델 자체가 단종/제공 중단된 경우입니다. 같은 모델을 재시도해도
        // 의미가 없으니 바로 다음 모델로 넘어갑니다.
        lastError = Object.assign(
          new Error(`Gemini 모델을 찾을 수 없습니다 (404): ${body.slice(0, 300)}`),
          { status: 404 }
        );
        break;
      }

      // 과부하·할당량·단종이 아닌 다른 오류(잘못된 키, 요청 형식 등)는 모델을
      // 바꿔도 똑같이 날 가능성이 높으므로 바로 던집니다.
      throw Object.assign(
        new Error(`Gemini API 오류 (${res.status}): ${body.slice(0, 300)}`),
        { status: 502 }
      );
    }
  }
  throw lastError;
}

function extractText(data) {
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

  const data = await callGeminiWithRetry(
    {
      contents: [{ parts: [{ text: promptText }] }],
      // Gemini가 마크다운 코드펜스 없이 순수 JSON만 반환하도록 강제합니다.
      generationConfig: { responseMimeType: "application/json" },
    },
    apiKey
  );
  return extractText(data);
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
// images: [{ data: base64문자열, mimeType }, ...] — 한 상품 페이지를 여러 장으로
// 나눠 찍은 스크린샷을 한 번에 보낼 수 있도록, 한 번의 요청에 모두 담아 보냅니다.
const MAX_IMAGES = 5;

async function extractFromImage(images) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw Object.assign(
      new Error(
        "GEMINI_API_KEY가 설정되지 않았습니다. .env 파일에 키를 추가한 뒤 서버를 다시 시작하세요."
      ),
      { status: 501 }
    );
  }
  const list = Array.isArray(images) ? images : [images];
  if (!list.length) {
    throw Object.assign(new Error("이미지가 없습니다."), { status: 400 });
  }
  if (list.length > MAX_IMAGES) {
    throw Object.assign(
      new Error(`스크린샷은 한 번에 최대 ${MAX_IMAGES}장까지 처리할 수 있습니다.`),
      { status: 400 }
    );
  }

  const multiNote =
    list.length > 1
      ? ` 스크린샷이 ${list.length}장 첨부되어 있으며, 같은 상품 페이지를 이어서 캡처한 것입니다. 모든 이미지를 함께 참고해 하나의 결과로 정리하세요.`
      : "";
  const prompt = `이 이미지는 어떤 쇼핑 상품 페이지의 스크린샷입니다.${multiNote} 이미지 안에서 실제로 보이는 정보만 사용해서 아래 항목을 추출하세요. 이미지에 없는 내용을 추측해서 만들지 마세요.

다음 JSON 형식으로만 답하세요:
{"productName":"상품명 (확인 안 되면 빈 문자열)","productDesc":"확인된 설명·구성·규격을 300자 이내로 요약 (광고 문구·과장 표현 제외)","keywords":["핵심 키워드 후보 최대 5개"],"highlights":["강조할 만한 확인된 포인트 후보 최대 5개"]}`;

  const imageParts = list.map((img) => ({
    inlineData: { mimeType: img.mimeType || "image/jpeg", data: img.data },
  }));

  const data = await callGeminiWithRetry(
    {
      contents: [
        {
          parts: [{ text: prompt }, ...imageParts],
        },
      ],
      generationConfig: { responseMimeType: "application/json" },
    },
    apiKey
  );
  const text = extractText(data);
  return parseJsonLoose(text);
}

module.exports = { generateDraftJson, suggestKeywords, extractFromPaste, extractFromImage };
