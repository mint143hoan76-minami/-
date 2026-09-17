const MODEL = "gemini-2.5-flash";

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

module.exports = { generateDraftJson };
