// 아주 단순한 파일 기반 저장소입니다.
// 개인용 도구 규모(글 수백 개 이하)에서는 충분하지만,
// 여러 명이 동시에 쓰는 서비스로 키우려면 Railway의 Postgres 같은
// 실제 데이터베이스로 교체하는 걸 추천합니다. (아래 각 함수의 시그니처만
// 유지하면 라우트 코드는 그대로 재사용할 수 있습니다.)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "drafts.json");

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");
}

function readAll() {
  ensureFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw || "[]");
  } catch (e) {
    console.error("drafts.json 읽기 실패, 빈 목록으로 시작합니다:", e.message);
    return [];
  }
}

function writeAll(list) {
  ensureFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), "utf8");
}

function getAll() {
  return readAll().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getById(id) {
  return readAll().find((d) => d.id === id) || null;
}

function create(data) {
  const list = readAll();
  const now = Date.now();
  const doc = {
    id: crypto.randomUUID(),
    status: "draft",
    step: 1,
    createdAt: now,
    updatedAt: now,
    ...data,
  };
  list.push(doc);
  writeAll(list);
  return doc;
}

function update(id, patch) {
  const list = readAll();
  const idx = list.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch, id, updatedAt: Date.now() };
  writeAll(list);
  return list[idx];
}

function remove(id) {
  const list = readAll();
  const next = list.filter((d) => d.id !== id);
  writeAll(next);
  return next.length !== list.length;
}

module.exports = { getAll, getById, create, update, remove };
