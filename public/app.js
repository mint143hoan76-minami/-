/* ---------- state ---------- */
const BLANK = () => ({
  id: null,
  status: "draft", // draft | ai_done | published
  step: 1,
  productUrl: "", productName: "", productDesc: "",
  mainKeywords: [], highlightKeywords: [],
  usedProduct: "no", userExperience: "",
  affiliateStatus: "naver", purchaseUrl: "",
  images: [""],
  ai: null,
  manualChecks: {},
  createdAt: null, updatedAt: null,
});

let cur = BLANK();
let view = "drafts"; // drafts | done | editor
let draftsCache = [];
let doneCache = [];
let generating = false, genError = null;
let scraping = false, scrapeError = null;
let aiConfigured = null; // null=unknown, true/false once /api/health responds

function toast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>t.classList.remove("show"), 2200);
}
function escapeHtml(s){
  return (s||"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function mdBold(s){
  return escapeHtml(s||"").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

/* ---------- API ---------- */
async function api(path, opts){
  const res = await fetch(path, {
    headers: {"content-type":"application/json"},
    ...opts,
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json().catch(()=>null) : null;
  if(!res.ok){
    const err = new Error(body?.error || `요청 실패 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function refreshLists(){
  try{
    const all = await api("/api/drafts");
    draftsCache = all.filter(d=>d.status!=="published");
    doneCache = all.filter(d=>d.status==="published");
  }catch(e){ /* 서버가 아직 없거나 오류인 경우 빈 목록으로 둠 */ }
  renderSidebarList();
}

let saveTimer = null;
function scheduleSave(){ clearTimeout(saveTimer); saveTimer = setTimeout(saveCur, 500); }
async function saveCur(){
  const title = cur.ai?.selectedTitle || cur.productName || "제목 없음";
  const body = {...cur, title};
  try{
    if(cur.id){
      const saved = await api(`/api/drafts/${cur.id}`, {method:"PUT", body:JSON.stringify(body)});
      cur.updatedAt = saved.updatedAt;
    } else {
      const saved = await api("/api/drafts", {method:"POST", body:JSON.stringify(body)});
      cur.id = saved.id; cur.createdAt = saved.createdAt; cur.updatedAt = saved.updatedAt;
    }
    refreshLists();
  }catch(e){ /* 오프라인이어도 화면 작업은 계속 가능하게 둠 */ }
}

/* ---------- product lookup (real server-side fetch) ---------- */
async function lookupProduct(){
  const url = (cur.productUrl||"").trim();
  if(!url){ scrapeError = "먼저 상품 URL을 입력해주세요."; render(); return; }
  scraping = true; scrapeError = null; render();
  try{
    const info = await api("/api/scrape", {method:"POST", body: JSON.stringify({url})});
    if(info.productName) cur.productName = info.productName;
    if(info.productDesc) cur.productDesc = info.productDesc;
    if(info.image && !cur.images[0]) cur.images[0] = info.image;
    if(Array.isArray(info.keywords) && info.keywords.length && cur.mainKeywords.length===0) cur.mainKeywords = info.keywords.slice(0,5);
    if(Array.isArray(info.highlights) && info.highlights.length && cur.highlightKeywords.length===0) cur.highlightKeywords = info.highlights.slice(0,8);
    scraping = false;
    scheduleSave();
    toast(info.incomplete ? "일부 정보만 확인됐어요. 빈 항목은 직접 채워주세요." : "상품 정보와 키워드를 가져왔어요.");
    render();
  }catch(e){
    scraping = false;
    scrapeError = e.message || "상품 정보를 가져오지 못했습니다.";
    render();
  }
}

/* ---------- AI draft generation ---------- */
async function generate(){
  generating = true; genError = null; render();
  try{
    const data = await api("/api/generate", {method:"POST", body: JSON.stringify(cur)});
    cur.ai = {
      titles: data.titles || [],
      selectedTitle: (data.titles && data.titles[0]) || "",
      intro: data.intro||"", coreInfo: data.coreInfo||"", why: data.why||"",
      details: data.details||"", guideOrReview: data.guideOrReview||"",
      audience: data.audience||"", faq: data.faq||[], conclusion: data.conclusion||"",
      disclosure: data.disclosure||"", tags: data.tags||[]
    };
    cur.status = "ai_done"; cur.step = 3;
    generating = false;
    scheduleSave();
    render();
  }catch(e){
    generating = false;
    genError = e.message || "초안 생성에 실패했습니다.";
    render();
  }
}

/* ---------- quality gate ---------- */
const BANNED = ["최고","보장","100%","무조건","1위","필수","최저가"];
function computeGate(d){
  const allText = d.ai ? [d.ai.intro,d.ai.coreInfo,d.ai.why,d.ai.details,d.ai.guideOrReview,d.ai.audience,d.ai.conclusion,
    ...(d.ai.faq||[]).map(f=>f.q+" "+f.a)].join(" ") : "";
  const hasBanned = BANNED.some(w=>allText.includes(w));
  const hasBold = /\*\*.+?\*\*/.test(allText);
  const hasDisclosure = d.affiliateStatus==="none" ? true : !!(d.ai && d.ai.disclosure && d.ai.disclosure.length>3);
  const hasImages = d.images.filter(x=>x.trim()).length>0;
  const hasPurchase = d.affiliateStatus==="none" ? true : !!d.purchaseUrl.trim();
  const hasKeywords = d.mainKeywords.length>0;

  return [
    {key:"exaggeration", label:"과장 표현 없음", auto:true, pass: d.ai ? !hasBanned : false},
    {key:"disclosure", label:"제휴 고지 반영", auto:true, pass: hasDisclosure},
    {key:"purchase", label:"구매 링크 확인", auto:true, pass: hasPurchase},
    {key:"images", label:"이미지 등록", auto:true, pass: hasImages},
    {key:"keywordbold", label:"핵심 키워드 강조", auto:true, pass: d.ai ? hasBold : false},
    {key:"keywords", label:"핵심 키워드 입력", auto:true, pass: hasKeywords},
    {key:"factuality", label:"상품 사실성 확인", auto:false, desc:"본문 내용이 실제 상품 정보와 일치하는지 직접 확인했습니다."},
    {key:"experience", label:"실사용 표현 확인", auto:false, desc:"실사용 여부와 글의 표현이 일치하는지 확인했습니다."},
    {key:"reference", label:"참고자료 사용 확인", auto:false, desc:"참고자료가 있었다면 문장을 그대로 쓰지 않고 사실 근거로 단정하지 않았습니다."},
    {key:"exposure", label:"노출 보장 표현 없음", auto:false, desc:"검색/AI 노출을 보장하거나 확정하는 표현이 없습니다."},
  ];
}

/* ---------- render ---------- */
function render(){
  renderSidebarList();
  document.querySelectorAll(".navbtn").forEach(b=>b.classList.toggle("active", b.dataset.view===view && view!=="editor"));
  if(view!=="editor"){
    document.getElementById("pageTitle").textContent = view==="drafts" ? "작성 중인 글" : "완료한 글";
    document.getElementById("steps").innerHTML = "";
    document.getElementById("footerbar").innerHTML = "";
    renderListView();
    return;
  }
  document.getElementById("pageTitle").textContent = cur.ai?.selectedTitle || cur.productName || "새 글 작성";
  renderSteps();
  renderStepContent();
  renderFooter();
}

function renderListView(){
  const c = document.getElementById("content");
  const list = view==="drafts" ? draftsCache : doneCache;
  if(list.length===0){
    c.innerHTML = `<div class="empty">${view==="drafts" ? "작성 중인 글이 없습니다. '새 글 작성'으로 시작하세요." : "완료한 글이 아직 없습니다."}</div>`;
    return;
  }
  c.innerHTML = list.map(d=>`
    <div class="block" style="cursor:pointer" data-open="${d.id}">
      <h3 style="color:var(--ink);font-size:14.5px;margin-bottom:4px;">${escapeHtml(d.title || "제목 없음")}</h3>
      <div style="font-size:12px;color:var(--ink-soft);">${escapeHtml(d.productName||"")} · ${new Date(d.updatedAt).toLocaleDateString("ko-KR")}</div>
    </div>`).join("");
  c.querySelectorAll("[data-open]").forEach(el=>{
    el.onclick = ()=>{ const d = list.find(x=>x.id===el.dataset.open); openDraft(d); };
  });
}

function openDraft(d){
  cur = {...BLANK(), ...d};
  view="editor"; render();
}

function renderSidebarList(){
  document.getElementById("draftCount").textContent = draftsCache.length ? `${draftsCache.length}` : "";
  document.getElementById("doneCount").textContent = doneCache.length ? `${doneCache.length}` : "";
  const el = document.getElementById("draftList");
  const list = (view==="done" ? doneCache : draftsCache).slice(0,15);
  el.innerHTML = list.map(d=>`
    <div class="draftitem ${cur.id===d.id?'active':''}" data-open="${d.id}">
      <span class="t">${escapeHtml(d.title||"제목 없음")}</span>
      <span class="s">${d.status==="ai_done"?"초안완료":d.status==="published"?"발행완료":"작성중"}</span>
    </div>`).join("");
  el.querySelectorAll("[data-open]").forEach(x=>{
    x.onclick = ()=>{
      const list2 = view==="done" ? doneCache : draftsCache;
      const d = list2.find(y=>y.id===x.dataset.open);
      if(d) openDraft(d);
    };
  });
}

const STEP_LABELS = ["자료 입력","AI 초안","사진·링크","최종 점검"];
function renderSteps(){
  document.getElementById("steps").innerHTML = STEP_LABELS.map((l,i)=>{
    const n = i+1;
    const cls = n===cur.step ? "active" : (n<cur.step ? "done" : "");
    return `<div class="step ${cls}" data-step="${n}"><span class="n">${n<cur.step?"✓":n}</span>${l}</div>`;
  }).join("");
  document.querySelectorAll(".step").forEach(s=>{
    s.onclick = ()=>{ const n=+s.dataset.step; if(n<=cur.step || cur.ai){ cur.step=n; render(); } };
  });
}

function renderStepContent(){
  const c = document.getElementById("content");
  if(cur.step===1) return renderStep1(c);
  if(cur.step===2) return renderStep2(c);
  if(cur.step===3) return renderStep3(c);
  if(cur.step===4) return renderStep4(c);
}

function keywordChips(list){
  return list.map((k,i)=>`<span class="tag">${escapeHtml(k)}<button data-i="${i}" class="rmtag">×</button></span>`).join("");
}

function renderStep1(c){
  c.innerHTML = `
    <div class="field">
      <label>상품 URL (쇼핑커넥트 링크)</label>
      <div style="display:flex;gap:8px;">
        <input type="url" id="f_url" value="${escapeHtml(cur.productUrl)}" placeholder="https://...">
        <button class="btn primary" id="lookupBtn" ${scraping?'disabled':''} style="flex:none;">${scraping?'확인 중…':'정보 확인'}</button>
      </div>
      <div class="hint">서버가 실제로 이 링크에 접속해 상품명·설명·대표 이미지를 가져옵니다.</div>
      ${scrapeError ? `<div style="color:var(--danger);font-size:12px;margin-top:6px;">${escapeHtml(scrapeError)}</div>` : ""}
    </div>
    <div class="field">
      <label>상품명</label>
      <input type="text" id="f_name" value="${escapeHtml(cur.productName)}" placeholder="정보 확인으로 자동 입력되거나 직접 입력하세요">
    </div>
    <div class="field">
      <label>상품 설명 / 확인된 정보</label>
      <textarea id="f_desc" placeholder="정보 확인으로 자동 입력되거나, 확인된 사실을 직접 붙여넣으세요.">${escapeHtml(cur.productDesc)}</textarea>
    </div>
    <div class="field">
      <label>핵심 키워드 (최대 5개)</label>
      <div class="tags" id="mainKwTags">${keywordChips(cur.mainKeywords)}</div>
      <div class="taginput"><input type="text" id="mainKwInput" placeholder="키워드 입력 후 Enter"><button class="btn" id="mainKwAdd">추가</button></div>
    </div>
    <div class="field">
      <label>강조할 포인트 (최대 8개)</label>
      <div class="tags" id="hlKwTags">${keywordChips(cur.highlightKeywords)}</div>
      <div class="taginput"><input type="text" id="hlKwInput" placeholder="강조 포인트 입력 후 Enter"><button class="btn" id="hlKwAdd">추가</button></div>
    </div>
    <div class="field">
      <label>실사용 여부</label>
      <div class="radiogroup">
        <label class="${cur.usedProduct==='no'?'sel':''}"><input type="radio" name="used" value="no" ${cur.usedProduct==='no'?'checked':''}> 실사용 안 함 (구매가이드형)</label>
        <label class="${cur.usedProduct==='yes'?'sel':''}"><input type="radio" name="used" value="yes" ${cur.usedProduct==='yes'?'checked':''}> 실사용함 (리뷰형)</label>
      </div>
    </div>
    ${cur.usedProduct==="yes" ? `
    <div class="field">
      <label>실제 사용 경험</label>
      <textarea id="f_exp" placeholder="직접 사용하며 느낀 점, 장단점, 사용 맥락을 적어주세요.">${escapeHtml(cur.userExperience)}</textarea>
    </div>` : ""}
    <div class="field">
      <label>제휴 프로그램</label>
      <select id="f_aff">
        <option value="naver" ${cur.affiliateStatus==='naver'?'selected':''}>네이버 쇼핑 커넥트</option>
        <option value="toss" ${cur.affiliateStatus==='toss'?'selected':''}>토스 쇼핑커넥트</option>
        <option value="none" ${cur.affiliateStatus==='none'?'selected':''}>제휴 없음</option>
      </select>
    </div>
  `;
  bindInput("f_url","productUrl"); bindInput("f_name","productName");
  bindInput("f_desc","productDesc"); bindInput("f_exp","userExperience");
  document.getElementById("lookupBtn").onclick = lookupProduct;
  document.getElementById("f_aff").onchange = e=>{ cur.affiliateStatus=e.target.value; scheduleSave(); };
  document.querySelectorAll('input[name=used]').forEach(r=> r.onchange = ()=>{ cur.usedProduct=r.value; scheduleSave(); render(); });
  bindTagInput("mainKwInput","mainKwAdd","mainKeywords",5);
  bindTagInput("hlKwInput","hlKwAdd","highlightKeywords",8);
  bindTagRemove("mainKwTags","mainKeywords");
  bindTagRemove("hlKwTags","highlightKeywords");
}

function bindInput(id, field){
  const el = document.getElementById(id);
  if(!el) return;
  el.oninput = ()=>{ cur[field]=el.value; scheduleSave(); };
}
function bindTagInput(inputId, btnId, field, max){
  const input = document.getElementById(inputId);
  const add = ()=>{
    const v = input.value.trim();
    if(v && cur[field].length<max){ cur[field].push(v); input.value=""; scheduleSave(); render(); }
  };
  document.getElementById(btnId).onclick = add;
  input.onkeydown = e=>{ if(e.key==="Enter"){ e.preventDefault(); add(); } };
}
function bindTagRemove(containerId, field){
  document.getElementById(containerId).querySelectorAll(".rmtag").forEach(btn=>{
    btn.onclick = ()=>{ cur[field].splice(+btn.dataset.i,1); scheduleSave(); render(); };
  });
}

function renderStep2(c){
  if(generating){
    c.innerHTML = `<div class="genpanel"><div class="spinner"></div><div>AI가 초안을 작성하고 있어요…</div></div>`;
    return;
  }
  if(!cur.ai){
    c.innerHTML = `
      ${aiConfigured===false ? `<div class="banner">서버에 GEMINI_API_KEY가 설정되지 않았어요. .env에 키를 추가하고 서버를 재시작하면 이 버튼이 동작합니다.</div>` : ""}
      <div class="genpanel">
        <div class="serif" style="font-size:16px;">입력한 정보로 초안을 생성할게요</div>
        <div class="hint" style="max-width:420px;">제목 후보 3개와 본문 초안이 만들어집니다. 생성 후에도 자유롭게 수정할 수 있어요.</div>
        ${genError ? `<div style="color:var(--danger);font-size:12.5px;">${escapeHtml(genError)}</div>` : ""}
        <button class="btn primary" id="genBtn">AI 초안 생성</button>
      </div>`;
    document.getElementById("genBtn").onclick = generate;
    return;
  }
  const a = cur.ai;
  c.innerHTML = `
    <div class="field"><label>제목 선택</label>
      <div class="titlepick" id="titlepick">
        ${a.titles.map((t)=>`<label class="titleopt ${a.selectedTitle===t?'sel':''}"><input type="radio" name="title" ${a.selectedTitle===t?'checked':''} data-t="${escapeHtml(t)}"> ${escapeHtml(t)}</label>`).join("")}
      </div>
    </div>
    ${a.disclosure ? `<div class="disclosurebox">${escapeHtml(a.disclosure)}</div>` : ""}
    <div class="block"><h3>도입부</h3><div class="txt">${mdBold(a.intro)}</div></div>
    <div class="block"><h3>상품 핵심정보</h3><div class="txt">${mdBold(a.coreInfo)}</div></div>
    <div class="block"><h3>왜 확인할 상품인가</h3><div class="txt">${mdBold(a.why)}</div></div>
    <div class="block"><h3>상세 정보</h3><div class="txt">${mdBold(a.details)}</div></div>
    <div class="block"><h3>${cur.usedProduct==='yes'?'실사용 경험':'구매가이드'}</h3><div class="txt">${mdBold(a.guideOrReview)}</div></div>
    <div class="block"><h3>추천/적합 대상</h3><div class="txt">${mdBold(a.audience)}</div></div>
    <div class="block"><h3>FAQ</h3>${(a.faq||[]).map(f=>`<div class="faqitem"><div class="q">Q. ${escapeHtml(f.q)}</div><div>A. ${mdBold(f.a)}</div></div>`).join("")}</div>
    <div class="block"><h3>마무리</h3><div class="txt">${mdBold(a.conclusion)}</div></div>
    <div class="block"><h3>태그</h3><div class="tagchips">${(a.tags||[]).map(t=>`<span class="tagchip">#${escapeHtml(t)}</span>`).join("")}</div></div>
    <button class="btn ghost" id="regenBtn">다시 생성하기</button>
  `;
  document.querySelectorAll('input[name=title]').forEach(r=> r.onchange = ()=>{ cur.ai.selectedTitle = r.dataset.t; scheduleSave(); render(); });
  document.getElementById("regenBtn").onclick = ()=>{ cur.ai=null; generate(); };
}

function renderStep3(c){
  c.innerHTML = `
    <div class="field">
      <label>이미지 링크</label>
      <div class="imglist" id="imgList">
        ${cur.images.map((v,i)=>`<div class="imgrow"><input type="url" data-i="${i}" class="imgin" value="${escapeHtml(v)}" placeholder="이미지 URL"><button class="btn ghost rmimg" data-i="${i}">삭제</button></div>`).join("")}
      </div>
      <button class="btn" id="addImg">+ 이미지 추가</button>
    </div>
    ${cur.affiliateStatus!=="none" ? `
    <div class="field">
      <label>구매 링크</label>
      <input type="url" id="f_purchase" value="${escapeHtml(cur.purchaseUrl)}" placeholder="발급받은 제휴 링크">
    </div>` : ""}
  `;
  document.querySelectorAll(".imgin").forEach(inp=>{ inp.oninput = ()=>{ cur.images[+inp.dataset.i]=inp.value; scheduleSave(); }; });
  document.querySelectorAll(".rmimg").forEach(btn=>{ btn.onclick = ()=>{ cur.images.splice(+btn.dataset.i,1); scheduleSave(); render(); }; });
  document.getElementById("addImg").onclick = ()=>{ cur.images.push(""); scheduleSave(); render(); };
  const pu = document.getElementById("f_purchase");
  if(pu) pu.oninput = ()=>{ cur.purchaseUrl = pu.value; scheduleSave(); };
}

function renderStep4(c){
  const items = computeGate(cur);
  const checked = items.filter(it=> it.auto ? it.pass : !!cur.manualChecks[it.key]).length;
  const pct = Math.round((checked/items.length)*100);
  c.innerHTML = `
    <div class="readybox">
      <svg class="ring" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="16" fill="none" stroke="var(--line)" stroke-width="3"/>
        <circle cx="18" cy="18" r="16" fill="none" stroke="var(--accent)" stroke-width="3" stroke-dasharray="${pct},100" stroke-linecap="round" transform="rotate(-90 18 18)"/>
      </svg>
      <div><div class="readynum">${pct}%</div><div class="hint">발행 준비도</div></div>
    </div>
    <div class="gate">
      ${items.map(it=>`
        <div class="gaterow">
          <span class="gatemark ${(it.auto?it.pass:!!cur.manualChecks[it.key])?'pass':'warn'}">${(it.auto?it.pass:!!cur.manualChecks[it.key])?'✓':'!'}</span>
          <div><div>${escapeHtml(it.label)}</div>${it.desc?`<div class="desc">${escapeHtml(it.desc)}</div>`:""}</div>
          ${it.auto ? "" : `<label class="toggle"><input type="checkbox" data-key="${it.key}" ${cur.manualChecks[it.key]?'checked':''}></label>`}
        </div>`).join("")}
    </div>
    <button class="btn primary" id="copyBtn">네이버용 전체 복사</button>
    <button class="btn ghost" id="doneBtn" style="margin-left:8px;">완료한 글로 표시</button>
  `;
  document.querySelectorAll('.gaterow input[type=checkbox]').forEach(cb=>{
    cb.onchange = ()=>{ cur.manualChecks[cb.dataset.key]=cb.checked; scheduleSave(); render(); };
  });
  document.getElementById("copyBtn").onclick = copyFinal;
  document.getElementById("doneBtn").onclick = ()=>{ cur.status="published"; scheduleSave(); toast("완료한 글로 표시했어요."); render(); };
}

function copyFinal(){
  const a = cur.ai; if(!a) return;
  const faq = (a.faq||[]).map(f=>`Q. ${f.q}\nA. ${f.a}`).join("\n\n");
  const text = [a.selectedTitle, a.disclosure, "", a.intro, "", a.coreInfo, "", a.why, "", a.details, "", a.guideOrReview,
    "", a.audience, "", faq, "", a.conclusion, "", (a.tags||[]).map(t=>"#"+t).join(" ")].filter(Boolean).join("\n\n");
  navigator.clipboard.writeText(text).then(()=> toast("클립보드에 복사했어요.")).catch(()=> toast("복사에 실패했어요."));
}

function renderFooter(){
  const f = document.getElementById("footerbar");
  const canNext = cur.step===1 ? (cur.productName.trim().length>0) : true;
  f.innerHTML = `
    <button class="btn ghost" id="prevBtn" ${cur.step===1?'disabled':''}>이전</button>
    <button class="btn primary" id="nextBtn" ${cur.step===4?'disabled':''} ${!canNext?'disabled':''}>${cur.step===1?'AI 초안으로':'다음'}</button>
  `;
  document.getElementById("prevBtn").onclick = ()=>{ if(cur.step>1){ cur.step--; render(); } };
  document.getElementById("nextBtn").onclick = ()=>{
    if(cur.step===1){ scheduleSave(); cur.step=2; render(); return; }
    if(cur.step<4){ cur.step++; render(); }
  };
}

/* ---------- nav ---------- */
document.getElementById("newBtn").onclick = ()=>{ cur = BLANK(); view="editor"; render(); };
document.querySelectorAll(".navbtn").forEach(b=>{ b.onclick = ()=>{ view=b.dataset.view; render(); }; });

/* ---------- init ---------- */
(async () => {
  try{
    const health = await api("/api/health");
    aiConfigured = !!health.aiConfigured;
  }catch(e){ aiConfigured = false; }
  await refreshLists();
  render();
})();
