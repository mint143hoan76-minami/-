// 브라우저(artifact)와 달리 여기는 진짜 서버라서 외부 사이트에 직접
// 접속할 수 있습니다. 쇼핑커넥트 링크는 대부분 실제 상품 페이지로
// 리다이렉트되는 짧은 링크이므로, fetch의 기본 redirect:"follow"로
// 최종 페이지까지 따라간 뒤 og:meta 태그를 읽습니다.
//
// 네이버 브랜드 커넥트 단축링크(naver.me)는 종종 HTTP 리다이렉트가 아니라
// 중간 페이지에서 JS/메타 리프레시로 실제 상품 페이지로 넘어가기 때문에,
// fetch의 자동 리다이렉트만으로는 그 중간 페이지에서 멈출 수 있습니다.
// 이런 경우를 감지해 한 번 더 따라갑니다.
//
// 헤더 구성: 예전에 실제로 성공했던 버전은 Referer 없이 User-Agent/Accept만
// 보냈습니다. Referer: naver.com을 붙였더니 오히려 더 잘 막히는 사례가
// 있었어서, 이번 버전은 그 성공했던 헤더 구성으로 되돌렸습니다.
//
// 429(요청 차단)는 코드 문제가 아니라 대상 쇼핑몰이 자동 접속을 막은 것이라
// 완전히 없앨 수는 없습니다. 대신 같은 헤더로 한 번 더 시도하고, 그래도
// 막히면 에러를 던지는 대신 "차단됨" 상태를 정상 응답으로 돌려줘서 화면이
// 놀란 오류창 대신 붙여넣기/스크린샷 쪽으로 부드럽게 안내하게 합니다.

const MAX_HTML_BYTES = 2_000_000; // 2MB 넘게 받지 않음 (이미지/스크립트가 큰 페이지 방지)
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 1_500;

// 성공했던 버전과 동일한 헤더 구성. Referer는 넣지 않습니다.
const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

// 실제 상품 페이지가 아니라 중간 안내 페이지일 때 흔히 걸리는 제목들.
// 이 중 하나가 og:title로 잡히면 "아직 진짜 상품 페이지에 도달하지 못했다"는 신호로 봅니다.
const GENERIC_TITLE_PATTERNS = [/브랜드\s*커넥트/, /쇼핑\s*커넥트/, /^네이버\s*쇼핑$/, /^네이버$/];

function extractMeta(html, property) {
  const patterns = [
    new RegExp(
      `<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']*)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${property}["']`,
      "i"
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeHtmlEntities(m[1]);
  }
  return "";
}

function extractTitleTag(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeHtmlEntities(m[1]).trim() : "";
}

// 중간 안내 페이지에 흔한 JS/메타 리프레시 리다이렉트를 찾아 다음 URL을 반환합니다. 못 찾으면 null.
function findClientRedirect(html, baseUrl) {
  const metaRefresh = html.match(
    /<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^;]*;\s*url=([^"']+)["']/i
  );
  if (metaRefresh) return resolveUrl(metaRefresh[1], baseUrl);

  const jsRedirect = html.match(
    /location(?:\.href)?\s*(?:=|\.replace\()\s*["']([^"']+)["']/i
  );
  if (jsRedirect) return resolveUrl(jsRedirect[1], baseUrl);

  return null;
}

function resolveUrl(target, baseUrl) {
  try {
    return new URL(target, baseUrl).toString();
  } catch {
    return null;
  }
}

function looksGeneric(title) {
  if (!title) return true;
  return GENERIC_TITLE_PATTERNS.some((re) => re.test(title));
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 반환값: { ok:true, html, finalUrl } 또는 { ok:false, status, message }
// (막힌 경우도 예외를 던지지 않고 값으로 돌려줘서, 재시도/차단 안내를 유연하게 처리합니다.)
async function fetchHtmlOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: REQUEST_HEADERS,
    });
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 502,
      message:
        e.name === "AbortError"
          ? "상품 페이지 응답이 너무 느려 시간 초과됐습니다."
          : "상품 페이지에 접속하지 못했습니다.",
    };
  }
  clearTimeout(timer);

  if (res.status === 429) {
    return {
      ok: false,
      status: 429,
      message: "이 쇼핑몰이 자동 접속을 일시적으로 차단했어요(429).",
    };
  }
  if (!res.ok) {
    return { ok: false, status: 502, message: `상품 페이지 응답 오류 (${res.status})` };
  }

  const reader = res.body?.getReader ? res.body.getReader() : null;
  let html;
  if (reader) {
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks.push(value);
      if (total >= MAX_HTML_BYTES) {
        controller.abort();
        break;
      }
    }
    html = Buffer.concat(chunks).toString("utf8");
  } else {
    html = await res.text();
  }
  return { ok: true, html, finalUrl: res.url || url };
}

// 429일 때 같은 헤더로 살짝 지연 후 한 번 더 시도합니다.
async function fetchHtmlWithRetry(url) {
  const first = await fetchHtmlOnce(url);
  if (first.ok) return first;
  if (first.status !== 429) return first;

  await sleep(RETRY_DELAY_MS + Math.floor(Math.random() * 800));
  return fetchHtmlOnce(url);
}

async function scrapeUrl(url) {
  if (!/^https?:\/\//i.test(url)) {
    throw Object.assign(new Error("올바른 URL이 아닙니다."), { status: 400 });
  }

  const first = await fetchHtmlWithRetry(url);
  if (!first.ok) {
    // 예외를 던지지 않고 "차단됨" 상태를 정상적인 결과로 돌려줍니다.
    // 라우트(index.js)에서 이 모양을 보고 200으로 응답해, 화면이 곧바로
    // 붙여넣기/스크린샷 쪽으로 안내할 수 있게 합니다.
    return {
      blocked: true,
      status: first.status,
      message:
        first.status === 429
          ? "이 쇼핑몰이 자동 접속을 반복적으로 차단하고 있어요. 시간을 두고 다시 시도하거나, 아래 붙여넣기/스크린샷 방법을 이용해주세요."
          : first.message + " 아래 붙여넣기/스크린샷 방법을 이용해주세요.",
      productName: "",
      productDesc: "",
      image: "",
    };
  }

  let { html, finalUrl } = first;
  let productName = extractMeta(html, "og:title") || extractTitleTag(html);

  // 최종 페이지가 아직 중간 안내 페이지로 보이면, 그 안의 JS/메타 리프레시를
  // 한 번 더 따라가서 진짜 상품 페이지를 시도합니다 (최대 1회).
  if (looksGeneric(productName)) {
    const nextUrl = findClientRedirect(html, finalUrl);
    if (nextUrl && nextUrl !== finalUrl) {
      const second = await fetchHtmlWithRetry(nextUrl);
      if (second.ok) {
        html = second.html;
        finalUrl = second.finalUrl;
        productName = extractMeta(html, "og:title") || extractTitleTag(html);
      }
      // 두 번째 시도가 실패해도 첫 번째 결과라도 돌려줍니다.
    }
  }

  const productDesc = extractMeta(html, "og:description");
  const image = extractMeta(html, "og:image");

  return {
    blocked: false,
    productName,
    productDesc,
    image,
    finalUrl,
    // 프런트에서 "이 정보가 비어있으면 직접 채워주세요" 안내에 쓸 수 있도록 표시
    incomplete: !productName || !productDesc || looksGeneric(productName),
  };
}

module.exports = { scrapeUrl };
