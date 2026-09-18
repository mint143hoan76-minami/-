// 브라우저(artifact)와 달리 여기는 진짜 서버라서 외부 사이트에 직접
// 접속할 수 있습니다. 쇼핑커넥트 링크는 대부분 실제 상품 페이지로
// 리다이렉트되는 짧은 링크이므로, fetch의 기본 redirect:"follow"로
// 최종 페이지까지 따라간 뒤 og:meta 태그를 읽습니다.
//
// 네이버 브랜드 커넥트 단축링크(naver.me)는 종종 HTTP 리다이렉트가 아니라
// 중간 페이지에서 JS/메타 리프레시로 실제 상품 페이지로 넘어가기 때문에,
// fetch의 자동 리다이렉트만으로는 그 중간 페이지에서 멈출 수 있습니다.
// 이런 경우를 감지해 한 번 더 따라갑니다.

const MAX_HTML_BYTES = 2_000_000; // 2MB 넘게 받지 않음 (이미지/스크립트가 큰 페이지 방지)
const FETCH_TIMEOUT_MS = 10_000;
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  Referer: "https://www.naver.com/",
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

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: BROWSER_HEADERS,
    });
  } catch (e) {
    throw Object.assign(
      new Error(
        e.name === "AbortError"
          ? "상품 페이지 응답이 너무 느려 시간 초과됐습니다."
          : "상품 페이지에 접속하지 못했습니다."
      ),
      { status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    throw Object.assign(
      new Error(
        "이 쇼핑몰이 자동 접속을 일시적으로 차단했어요(429). 잠시 후 다시 시도하거나, 아래 항목에 직접 입력해주세요."
      ),
      { status: 429 }
    );
  }
  if (!res.ok) {
    throw Object.assign(new Error(`상품 페이지 응답 오류 (${res.status})`), {
      status: 502,
    });
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
  return { html, finalUrl: res.url || url };
}

async function scrapeUrl(url) {
  if (!/^https?:\/\//i.test(url)) {
    throw Object.assign(new Error("올바른 URL이 아닙니다."), { status: 400 });
  }

  let { html, finalUrl } = await fetchHtml(url);
  let productName = extractMeta(html, "og:title") || extractTitleTag(html);

  // 최종 페이지가 아직 중간 안내 페이지로 보이면, 그 안의 JS/메타 리프레시를
  // 한 번 더 따라가서 진짜 상품 페이지를 시도합니다 (최대 1회).
  if (looksGeneric(productName)) {
    const nextUrl = findClientRedirect(html, finalUrl);
    if (nextUrl && nextUrl !== finalUrl) {
      try {
        const second = await fetchHtml(nextUrl);
        html = second.html;
        finalUrl = second.finalUrl;
        productName = extractMeta(html, "og:title") || extractTitleTag(html);
      } catch (e) {
        // 두 번째 시도가 실패해도 첫 번째 결과라도 돌려줍니다.
      }
    }
  }

  const productDesc = extractMeta(html, "og:description");
  const image = extractMeta(html, "og:image");

  return {
    productName,
    productDesc,
    image,
    finalUrl,
    // 프런트에서 "이 정보가 비어있으면 직접 채워주세요" 안내에 쓸 수 있도록 표시
    incomplete: !productName || !productDesc || looksGeneric(productName),
  };
}

module.exports = { scrapeUrl };
