const path = require("path");
const express = require("express");

const store = require("./store");
const { scrapeUrl } = require("./scrape");
const { buildDraftPrompt } = require("./prompts");
const { generateDraftJson, suggestKeywords } = require("./gemini");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// ---- 상품 정보 자동 확인 (실제 서버 스크래핑 + 키워드 제안) ----
app.post("/api/scrape", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url이 필요합니다." });
  try {
    const info = await scrapeUrl(url);
    // 키워드 제안은 곁가지 기능이라, 실패하거나 API 키가 없어도
    // 스크래핑 결과 자체는 정상적으로 돌려줍니다.
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
