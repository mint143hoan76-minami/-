const path = require("path");
const express = require("express");

const store = require("./store");
const { scrapeUrl } = require("./scrape");
const { buildDraftPrompt } = require("./prompts");
const { generateDraftJson, suggestKeywords, extractFromPaste, extractFromImage } = require("./gemini");

const app = express();
// 스크린샷을 최대 10장까지 base64로 한 번에 보낼 수 있도록 넉넉하게 잡습니다.
app.use(express.json({ limit: "40mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// ---- 상품 정보 자동 확인 (실제 서버 스크래핑 + 키워드 제안) ----
app.post("/api/scrape", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url이 필요합니다." });
  try {
    const info = await scrapeUrl(url);
    // scrapeUrl은 접속이 막혀도 예외를 던지지 않고 { blocked:true, ... }를
    // 돌려줍니다. 막힌 경우는 그대로 200으로 응답해, 화면이 오류창 대신
    // 붙여넣기/스크린샷 안내로 부드럽게 넘어가게 합니다.
    if (info.blocked) {
      return res.json(info);
    }
    if (process.env.GEMINI_API_KEY && info.productName) {
      try {
        const suggestion = await suggestKeywords(info.productName, info.productDesc);
        info.keywords = Array.isArray(suggestion.keywords) ? suggestion.keywords.slice(0, 5) : [];
        info.highlights = Array.isArray(suggestion.highlights) ? suggestion.highlights.slice(0, 5) : [];
      } catch (e) {
        // 키워드 제안 실패는 조용히 넘어갑니다 — 상품 정보 확인 자체는 성공했으므로.
      }
    }
    res.json(info);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- 자동 접속이 막힌 페이지용: 붙여넣은 내용에서 정보 정리 ----
app.post("/api/extract", async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "붙여넣은 내용이 없습니다." });
  try {
    const info = await extractFromPaste(text);
    res.json(info);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- 자동 접속이 막힌 페이지용: 스크린샷 이미지(최대 10장)에서 정보 정리 ----
app.post("/api/extract-image", async (req, res) => {
  const { images } = req.body || {};
  if (!Array.isArray(images) || !images.length) {
    return res.status(400).json({ error: "이미지가 없습니다." });
  }
  try {
    const info = await extractFromImage(images);
    res.json(info);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- AI 초안 생성 ----
app.post("/api/generate", async (req, res) => {
  try {
    const prompt = buildDraftPrompt(req.body || {});
    const draft = await generateDraftJson(prompt);
    res.json(draft);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- 초안 CRUD ----
app.get("/api/drafts", (req, res) => {
  res.json(store.getAll());
});

app.get("/api/drafts/:id", (req, res) => {
  const doc = store.getById(req.params.id);
  if (!doc) return res.status(404).json({ error: "찾을 수 없습니다." });
  res.json(doc);
});

app.post("/api/drafts", (req, res) => {
  res.status(201).json(store.create(req.body || {}));
});

app.put("/api/drafts/:id", (req, res) => {
  const doc = store.update(req.params.id, req.body || {});
  if (!doc) return res.status(404).json({ error: "찾을 수 없습니다." });
  res.json(doc);
});

app.delete("/api/drafts/:id", (req, res) => {
  const ok = store.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: "찾을 수 없습니다." });
  res.status(204).end();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, aiConfigured: !!process.env.GEMINI_API_KEY });
});

// SPA fallback: API 이외의 모든 경로는 index.html로
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.log(
      "GEMINI_API_KEY가 설정되지 않았습니다 — AI 초안 생성은 아직 동작하지 않습니다."
    );
  }
});
