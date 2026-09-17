// 브라우저(artifact)와 달리 여기는 진짜 서버라서 외부 사이트에 직접
// 접속할 수 있습니다. 쇼핑커넥트 링크는 대부분 실제 상품 페이지로
// 리다이렉트되는 짧은 링크이므로, fetch의 기본 redirect:"follow"로
// 최종 페이지까지 따라간 뒤 og:meta 태그를 읽습니다.

const MAX_HTML_BYTES = 2_000_000; // 2MB 넘게 받지 않음 (이미지/스크립트가 큰 페이지 방지)
const FETCH_TIMEOUT_MS = 10_000;

function extractMeta(html, property) {
  // <meta property="og:title" content="..."> 순서가 바뀌어 있는 경우까지 커버
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

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

async function scrapeUrl(url) {
  if (!/^https?:\/\//i.test(url)) {
    throw Object.assign(new Error("올바른 URL이 아닙니다."), { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // 일부 쇼핑몰은 기본 fetch User-Agent를 차단하므로 일반 브라우저처럼 위장합니다.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
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

  if (!res.ok) {
    throw Object.assign(
      new Error(`상품 페이지 응답 오류 (${res.status})`),
      { status: 502 }
    );
  }

  // 스트림을 MAX_HTML_BYTES까지만 읽어서 거대한 페이지에도 안전하게 처리합니다.
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

  const productName = extractMeta(html, "og:title") || extractTitleTag(html);
  const productDesc = extractMeta(html, "og:description");
  const image = extractMeta(html, "og:image");
  const finalUrl = res.url || url;

  return {
    productName,
    productDesc,
    image,
    finalUrl,
    // 프런트에서 "이 정보가 비어있으면 직접 채워주세요" 안내에 쓸 수 있도록 표시
    incomplete: !productName || !productDesc,
  };
}

module.exports = { scrapeUrl };
