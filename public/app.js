// Skills Hub admin SPA — no build step, hash routing.
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const store = {
  get token() { return localStorage.getItem("sp_token") || ""; },
  set token(v) { v ? localStorage.setItem("sp_token", v) : localStorage.removeItem("sp_token"); },
};

// theme toggle — the inline <head> script owns first paint; this only flips + persists
const themeBtn = document.getElementById("theme-toggle");
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("sp_theme", t);
  themeBtn.textContent = t === "dark" ? "☀️" : "🌙";
}
themeBtn.addEventListener("click", () =>
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
setTheme(document.documentElement.dataset.theme || "light");

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", authorization: `Bearer ${store.token}`, ...(opts.headers || {}) },
  });
  if (res.status === 401) { store.token = ""; render(); throw new Error("unauthorized"); }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer = null;
function toast(msg, opts = {}) {
  const { isErr = false, action, onAction } = opts;
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = el("div", { class: `toast${isErr ? " err" : ""}` }, msg,
    action ? el("button", { class: "toast-action", onclick: () => { t.remove(); onAction(); } }, action) : null);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), action ? 8000 : 4200);
}

// in-app confirm dialog (native confirm() is blocked-looking and unstylable)
function confirmDialog(title, body, confirmLabel = "Confirm") {
  return new Promise((resolve) => {
    const close = (v) => { backdrop.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(false); };
    const cancel = el("button", { class: "btn", onclick: () => close(false) }, "Cancel");
    const ok = el("button", { class: "btn danger", onclick: () => close(true) }, confirmLabel);
    const backdrop = el("div", { class: "backdrop", onclick: (e) => { if (e.target === backdrop) close(false); } },
      el("div", { class: "modal confirm-modal", role: "alertdialog", "aria-modal": "true", "aria-label": title },
        el("h2", {}, title),
        el("p", { class: "confirm-body" }, body),
        el("div", { class: "confirm-actions" }, cancel, ok)));
    document.body.append(backdrop);
    document.addEventListener("keydown", onKey);
    ok.focus();
  });
}

const PAGES = [
  ["dashboard", "Overview"],
  ["skills", "Skills"],
  ["pending", "Pending"],
  ["taxonomy", "Categories"],
  ["tokens", "Tokens"],
  ["sources", "Sources"],
  ["ai", "AI desk"],
  ["audit", "Audit"],
];

function pill(status) {
  const cls = ["published", "pending", "draft", "deprecated", "flag"].includes(status) ? status : "draft";
  return el("span", { class: `pill ${cls}` }, status);
}

let state = { page: "dashboard", skill: null, token: null };

function render() {
  const nav = $("#nav");
  nav.replaceChildren();
  if (!store.token) {
    nav.append(el("button", { onclick: () => { store.token = ""; render(); } }, "Sign out"));
  } else {
    for (const [id, label] of PAGES) {
      nav.append(el("button", { "aria-current": state.page === id ? "page" : null, onclick: () => go(id) }, label));
    }
    nav.append(el("button", { onclick: () => { store.token = ""; state.page = "dashboard"; render(); } }, "Sign out"));
  }
  const app = $("#app");
  if (!store.token) return renderLogin(app);
  const view = { dashboard: viewDashboard, skills: viewSkills, pending: viewPending, taxonomy: viewTaxonomy, tokens: viewTokens, sources: viewSources, ai: viewAi, audit: viewAudit }[state.page] || viewDashboard;
  view(app);
}

function go(page) {
  state.page = page;
  state.skill = null;
  state.token = null;
  location.hash = page;
  render();
}

function renderLogin(app) {
  const input = el("input", { type: "password", placeholder: "sk_…", autocomplete: "off" });
  const submit = async () => {
    store.token = input.value.trim();
    try { await api("/api/stats"); render(); }
    catch { toast("That token was not accepted.", true); render(); }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  app.replaceChildren(
    el("div", { class: "page-head" }, el("h1", {}, "Sign in")),
    el("div", { class: "panel", style: "max-width:520px" },
      el("p", { class: "muted", style: "margin-top:0" }, "Paste the admin token printed on first boot, or the token in your ADMIN_TOKEN environment variable."),
      el("div", { class: "form-row" }, el("div", {}, el("label", {}, "Admin token"), input)),
      el("button", { class: "btn primary", onclick: submit }, "Open the catalog"),
    ),
  );
  input.focus();
}

// ---------- dashboard ----------
async function viewDashboard(app) {
  app.replaceChildren(el("div", { class: "empty" }, "Reading the catalog…"));
  try {
    const [stats, audit, usage] = await Promise.all([api("/api/stats"), api("/api/audit?limit=8"), api("/api/usage?limit=6")]);
    const cards = Object.entries({
      "skills": stats.skills, "published": stats.published, "pending versions": stats.pending_versions,
      "categories": stats.categories, "collections": stats.collections, "live tokens": stats.tokens,
    }).map(([k, v]) => el("div", { class: "stat" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v)));
    app.replaceChildren(
      el("div", { class: "page-head" }, el("h1", {}, "Overview"), el("span", { class: "count" }, "the catalog at a glance")),
      el("div", { class: "grid-stats" }, cards),
      el("div", { class: "split" },
        el("div", { class: "panel" }, el("h2", {}, "Recent activity"),
          audit.length === 0 ? el("div", { class: "empty" }, el("strong", {}, "Nothing recorded yet"), "Actions appear here as you publish, assign and approve.") :
          el("table", { class: "ledger" }, el("tbody", {}, ...audit.map((a, i) => el("tr", { class: "row" },
            el("td", { class: "idx" }, String(i + 1).padStart(2, "0")),
            el("td", { class: "mono" }, a.action),
            el("td", { class: "muted" }, `${a.actor_kind}${a.actor_id ? " #" + a.actor_id : ""}`),
            el("td", { class: "num right" }, a.ts),
          ))))),
        el("div", { class: "panel" }, el("h2", {}, "Most loaded skills"),
          usage.length === 0 ? el("div", { class: "empty" }, el("strong", {}, "No agent reads yet"), "Connect a client token over MCP and the skills it loads show up here.") :
          el("table", { class: "ledger" }, el("tbody", {}, ...usage.map((u, i) => el("tr", { class: "row" },
            el("td", { class: "idx" }, String(i + 1).padStart(2, "0")),
            el("td", { class: "name" }, u.skill_name),
            el("td", { class: "num" }, u.skill_version || "—"),
            el("td", { class: "num right" }, u.n === 1 ? "1 load" : `${u.n} loads`),
          ))))),
      ),
    );
  } catch (e) { app.replaceChildren(errorPanel(e)); }
}

function errorPanel(e) {
  return el("div", { class: "error-banner" }, `Could not load: ${e.message}`);
}

// ---------- skills ----------
function tagChips(tags) {
  return el("div", { class: "chips" }, ...tags.map((t) => el("span", { class: "chip", title: `tag: ${t}` }, t)));
}

async function viewSkills(app) {
  if (state.skill) return viewSkillDetail(app, state.skill);
  app.replaceChildren(el("div", { class: "empty" }, "Reading the catalog…"));
  try {
    const [skills, cats, tags] = await Promise.all([api("/api/skills"), api("/api/categories"), api("/api/tags")]);
    const search = el("input", { type: "text", placeholder: "Filter skills…" });
    const statusFilter = el("select", {}, el("option", { value: "" }, "all statuses"), ...["published", "draft", "deprecated"].map((s) => el("option", { value: s }, s)));

    // Hermes-style left menu: categories + tags, each with a live count.
    // Filters compose: one category (or all), any number of tags, text, status.
    let activeCat = "";
    const activeTags = new Set();
    // deep-link handoff from the taxonomy view (click a count there, land filtered here)
    const handoffCat = sessionStorage.getItem("skills_filter_cat");
    const handoffTag = sessionStorage.getItem("skills_filter_tag");
    if (handoffCat) { activeCat = handoffCat; sessionStorage.removeItem("skills_filter_cat"); }
    if (handoffTag) { activeTags.add(handoffTag); sessionStorage.removeItem("skills_filter_tag"); }
    const matchesBase = (s) => {
      const q = search.value.toLowerCase();
      return (!q || s.name.toLowerCase().includes(q) || (s.tags || []).some((t) => t.includes(q))) &&
        (!statusFilter.value || s.status === statusFilter.value);
    };
    const catCount = (id) => skills.filter((s) => String(s.category_id) === String(id) && matchesBase(s)).length;
    const menu = el("nav", { class: "side-menu", "aria-label": "Browse by category or tag" });
    const drawMenu = () => {
      const catBtn = (label, value, count) =>
        el("button", { class: `side-link${activeCat === value ? " on" : ""}`, "aria-pressed": activeCat === value ? "true" : "false", onclick: () => { activeCat = activeCat === value ? "" : value; drawMenu(); draw(); } },
          el("span", {}, label), el("span", { class: "side-count num" }, String(count)));
      menu.replaceChildren(
        el("div", { class: "side-head" }, "Categories"),
        catBtn("All skills", "", skills.filter(matchesBase).length),
        ...cats.map((c) => catBtn(c.name, String(c.id), catCount(c.id))),
        el("div", { class: "side-head" }, "Tags"),
        ...tags.filter((t) => t.skill_count > 0).map((t) =>
          el("button", { class: `side-link${activeTags.has(t.name) ? " on" : ""}`, "aria-pressed": activeTags.has(t.name) ? "true" : "false", onclick: () => { activeTags.has(t.name) ? activeTags.delete(t.name) : activeTags.add(t.name); drawMenu(); draw(); } },
            el("span", {}, t.name), el("span", { class: "side-count num" }, String(t.skill_count)))),
      );
    };

    const tableBody = el("tbody");
    const selected = new Set();
    const deleteBtn = el("button", { class: "btn small danger", style: "display:none", onclick: deleteSelected });
    const selCount = el("span", { class: "muted", style: "display:none;font-size:var(--fs-sm)" });
    const syncDeleteBtn = () => {
      const n = selected.size;
      deleteBtn.style.display = n ? "" : "none";
      selCount.style.display = n ? "" : "none";
      if (n) selCount.textContent = `${n} selected`;
      deleteBtn.textContent = n === 1 ? "Delete 1 skill" : `Delete ${n} skills`;
    };
    // undo > confirm: deletion stays reversible for 8s, then permanent (NN/g)
    async function deleteSelected() {
      const n = selected.size;
      try {
        const r = await api("/api/skills/delete-batch", { method: "POST", body: JSON.stringify({ names: [...selected] }) });
        selected.clear();
        render();
        toast(`Deleted ${r.deleted} skill${r.deleted === 1 ? "" : "s"}`, {
          action: "Undo", onAction: async () => {
            try {
              const u = await api("/api/skills/undo-delete", { method: "POST", body: JSON.stringify({ undo_id: r.undo_id }) });
              toast(u.skipped.length ? `Restored ${u.restored.length}; ${u.skipped.join(", ")} was recreated meanwhile` : `Restored ${u.restored.join(", ")}`);
              render();
            } catch (e2) { toast(e2.message, true); }
          },
        });
      } catch (e) { toast(e.message, true); }
    }

    const draw = () => {
      const rows = skills.filter((s) =>
        matchesBase(s) &&
        (!activeCat || String(s.category_id) === activeCat) &&
        (activeTags.size === 0 || [...activeTags].every((t) => (s.tags || []).includes(t))));
      if (rows.length === 0) {
        tableBody.replaceChildren(
          el("tr", {}, el("td", { colspan: 7 },
            el("div", { class: "empty" }, el("strong", {}, "No skills match"), "Adjust the filters, or create a skill or import a repo."))),
        );
        return;
      }
      // grouped by category: flat rows lose the filing, a category order keeps related skills together
      const byCat = new Map();
      for (const r of rows) {
        const key = r.category || "Uncategorized";
        if (!byCat.has(key)) byCat.set(key, []);
        byCat.get(key).push(r);
      }
      const ordered = [...byCat.entries()].sort((a, b) => (a[0] === "Uncategorized") - (b[0] === "Uncategorized") || a[0].localeCompare(b[0]));
      const out = [];
      for (const [cat, items] of ordered) {
        out.push(el("tr", { class: "group-row" }, el("td", { colspan: 7 },
          el("span", { class: "group-label" }, cat),
          el("span", { class: "muted" }, ` ${items.length} skill${items.length === 1 ? "" : "s"}`))));
        for (const [i, s] of items.entries()) {
          const open = () => { state.skill = s.name; render(); };
          const box = el("input", { type: "checkbox", "aria-label": `Select ${s.name}`, checked: selected.has(s.name) ? true : null });
          box.addEventListener("click", (e) => e.stopPropagation());
          box.addEventListener("change", () => { box.checked ? selected.add(s.name) : selected.delete(s.name); syncDeleteBtn(); });
          const del = el("button", { class: "row-del", title: `Delete ${s.name}`, "aria-label": `Delete ${s.name}`, onclick: async (e) => {
            e.stopPropagation();
            try {
              const r = await api(`/api/skills/${encodeURIComponent(s.name)}`, { method: "DELETE", body: "{}" });
              render();
              toast(`Deleted ${s.name}`, {
                action: "Undo", onAction: async () => {
                  try {
                    await api("/api/skills/undo-delete", { method: "POST", body: JSON.stringify({ undo_id: r.undo_id }) });
                    toast(`Restored ${s.name}`);
                    render();
                  } catch (e2) { toast(e2.message, true); }
                },
              });
            } catch (e2) { toast(e2.message, true); }
          } }, "✕");
          out.push(el("tr", { class: "row", tabindex: "0", onclick: open, onkeydown: (e) => { if (e.key === "Enter") open(); } },
            el("td", { class: "cell-check" }, box),
            el("td", { class: "name-cell" }, el("span", { class: "name" }, s.name),
              s.description ? el("span", { class: "row-desc" }, s.description) : null),
            el("td", { class: "col-desc" }, tagChips(s.tags || [])),
            el("td", { class: "num" }, s.current_semver || "—"),
            el("td", {}, pill(s.status)),
            el("td", { class: "num right" }, s.updated_at?.slice(0, 10) || ""),
            el("td", { class: "right" }, del)));
        }
      }
      tableBody.replaceChildren(...out);
      syncDeleteBtn();
    };
    search.addEventListener("input", () => { drawMenu(); draw(); });
    statusFilter.addEventListener("change", () => { drawMenu(); draw(); });
    drawMenu();
    draw();

    app.replaceChildren(
      el("div", { class: "page-head" }, el("h1", {}, "Skills"), el("span", { class: "count" }, `${skills.length} records`),
        el("div", { class: "actions" }, deleteBtn, selCount, el("button", { class: "btn primary", onclick: () => newSkillDialog(cats) }, "New skill"))),
      el("div", { class: "split-menu" },
        menu,
        el("div", {},
          el("div", { class: "toolbar" }, search, statusFilter),
          el("table", { class: "ledger" },
            el("thead", {}, el("tr", {}, el("th", { class: "cell-check" }), el("th", {}, "Skill"), el("th", { class: "col-desc" }, "Tags"), el("th", {}, "Version"), el("th", {}, "Status"), el("th", { class: "right" }, "Updated"), el("th", {}, ""))),
            tableBody))),
    );
  } catch (e) { app.replaceChildren(errorPanel(e)); }
}

function newSkillDialog(cats) {
  const name = el("input", { type: "text", placeholder: "pdf-report" });
  const desc = el("input", { type: "text", placeholder: "What it does. Use when …" });
  const body = el("textarea", { placeholder: "# Instructions\n\n1. …" });
  const cat = el("select", {}, el("option", { value: "" }, "uncategorized"), ...cats.map((c) => el("option", { value: c.id }, c.name)));
  const tagsIn = el("input", { type: "text", placeholder: "pdf, reporting, onboarding" });
  const ver = el("input", { type: "text", value: "0.1.0" });
  const close = () => backdrop.remove();
  const save = async () => {
    try {
      await api("/api/skills", { method: "POST", body: JSON.stringify({
        name: name.value.trim(), description: desc.value.trim(), body: body.value,
        category_id: cat.value ? Number(cat.value) : null, semver: ver.value.trim() || "0.1.0", publish: true,
      }) });
      const tagList = tagsIn.value.split(",").map((t) => t.trim()).filter(Boolean);
      if (tagList.length) await api(`/api/skills/${encodeURIComponent(name.value.trim())}`, { method: "PATCH", body: JSON.stringify({ tags: tagList }) });
      close(); toast(`Skill '${name.value.trim()}' created`); render();
    } catch (e) { toast(e.message, true); }
  };
  const backdrop = el("div", { class: "backdrop", onclick: (e) => { if (e.target === backdrop) close(); } },
    el("div", { class: "modal" },
      el("h2", { style: "margin-bottom:16px" }, "New skill"),
      el("div", { class: "form-row" }, el("div", {}, el("label", {}, "Name"), name), el("div", {}, el("label", {}, "Version"), ver)),
      el("div", { class: "form-row" }, el("div", {}, el("label", {}, "Description"), desc)),
      el("div", { class: "form-row" }, el("div", {}, el("label", {}, "Tags (comma-separated)"), tagsIn)),
      el("div", { class: "form-row" }, el("div", {}, el("label", {}, "Category"), cat)),
      el("div", { class: "form-row" }, el("div", {}, el("label", {}, "SKILL.md body"), body)),
      el("div", { class: "checkline", style: "justify-content:flex-end;gap:8px" },
        el("button", { class: "btn", onclick: close }, "Cancel"),
        el("button", { class: "btn primary", onclick: save }, "Publish")),
    ));
  document.body.append(backdrop);
  name.focus();
}

async function viewSkillDetail(app, name) {
  app.replaceChildren(el("div", { class: "empty" }, "Reading record…"));
  try {
    const s = await api(`/api/skills/${encodeURIComponent(name)}`);
    const cats = await api("/api/categories");
    const catSel = el("select", {}, el("option", { value: "" }, "uncategorized"), ...cats.map((c) => el("option", { value: c.id, selected: c.id === s.category_id }, c.name)));
    catSel.addEventListener("change", async () => {
      await api(`/api/skills/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ category_id: catSel.value ? Number(catSel.value) : null }) });
      toast("Category updated"); render();
    });
    const statusSel = el("select", {}, ...["draft", "published", "deprecated"].map((st) => el("option", { value: st, selected: st === s.status }, st)));
    statusSel.addEventListener("change", async () => {
      await api(`/api/skills/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ status: statusSel.value }) });
      toast("Status updated"); render();
    });
    const tagsIn = el("input", { type: "text", value: (s.tags || []).join(", "), placeholder: "pdf, reporting" });
    const saveTags = async () => {
      await api(`/api/skills/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ tags: tagsIn.value.split(",").map((t) => t.trim()).filter(Boolean) }) });
      toast("Tags saved");
    };
    tagsIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveTags(); } });

    const versionRows = s.versions.map((v, i) => el("tr", { class: "row" },
      el("td", { class: "idx" }, String(i + 1).padStart(2, "0")),
      el("td", { class: "name" }, v.semver),
      el("td", {}, pill(v.status)),
      el("td", { class: "num" }, `lint ${v.lint_score}`),
      el("td", { class: "muted" }, v.author_kind),
      el("td", { class: "right" },
        v.status === "pending" ? el("span", { style: "display:flex;gap:4px;justify-content:flex-end" },
          el("button", { class: "btn small primary", onclick: async () => { await api(`/api/versions/${v.id}/approve`, { method: "POST", body: "{}" }); toast(`Approved ${v.semver}`); render(); } }, "Approve"),
          el("button", { class: "btn small danger", onclick: async () => { await api(`/api/versions/${v.id}/reject`, { method: "POST", body: "{}" }); toast(`Rejected ${v.semver}`); render(); } }, "Reject"),
        ) : v.id === s.current_version_id ? el("span", { class: "pill published" }, "current") : "")));

    const nodes = [
      el("div", { class: "page-head" },
        el("h1", { class: "mono", style: "font-size:1.5625rem" }, s.name),
        pill(s.status),
        el("div", { class: "actions" }, el("button", { class: "btn", onclick: () => go("skills") }, "Back to skills"))),
    ];
    if (s.security_flags?.length) {
      nodes.push(el("div", { class: "error-banner" }, "Security review required: " + s.security_flags.join(" · ")));
    }
    app.replaceChildren(
      ...nodes,
      el("div", { class: "split" },
        el("div", { class: "panel" },
          el("h2", {}, "Record"),
          el("dl", { class: "kv" },
            el("dt", {}, "Source"), el("dd", {}, s.source),
            el("dt", {}, "Current version"), el("dd", {}, s.current_semver || "—"),
            el("dt", {}, "Created"), el("dd", {}, s.created_at),
            el("dt", {}, "Updated"), el("dd", {}, s.updated_at)),
          el("div", { class: "form-row", style: "margin-top:24px" }, el("div", {}, el("label", {}, "Category"), catSel)),
          el("div", { class: "form-row" }, el("div", { class: "tagline" }, el("label", {}, "Tags"), tagsIn, el("button", { class: "btn small", onclick: saveTags }, "Save"))),
          el("div", { class: "form-row" }, el("div", {}, el("label", {}, "Status"), statusSel)),
        ),
        el("div", { class: "panel" },
          el("h2", {}, "Versions"),
          el("table", { class: "ledger" },
            el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Version"), el("th", {}, "State"), el("th", {}, "Lint"), el("th", {}, "Author"), el("th", {}))),
            el("tbody", {}, ...versionRows))),
      ),
    );
    if (s.current) {
      const parts = [el("h2", {}, "Instructions"), el("pre", { class: "code" }, s.current.body)];
      if (s.current.files?.length) {
        parts.push(el("h3", {}, "Bundled files"));
        parts.push(el("table", { class: "ledger" }, el("tbody", {}, ...s.current.files.map((f) =>
          el("tr", {},
            el("td", { class: "name" }, f.path),
            el("td", { class: "num" }, f.size + " B"),
            el("td", { class: "num right", title: f.sha256 }, f.sha256.slice(0, 12) + "…"))))));
      }
      if (s.current.lint_report?.length) {
        parts.push(el("h3", {}, "Lint report"));
        parts.push(el("table", { class: "ledger" }, el("tbody", {}, ...s.current.lint_report.map((d) =>
          el("tr", {},
            el("td", {}, pill(d.level === "error" ? "flag" : "pending")),
            el("td", { class: "name" }, d.field || "—"),
            el("td", { class: "desc", style: "max-width:none;white-space:normal" }, d.message))))));
      }
      app.append(el("div", { class: "panel" }, ...parts));
    }
  } catch (e) { app.replaceChildren(errorPanel(e), el("button", { class: "btn", onclick: () => go("skills") }, "Back")); }
}

// ---------- pending ----------
async function viewPending(app) {
  app.replaceChildren(el("div", { class: "empty" }, "Reading queue…"));
  try {
    const rows = await api("/api/versions/pending");
    app.replaceChildren(
      el("div", { class: "page-head" }, el("h1", {}, "Pending approval"), el("span", { class: "count" }, `${rows.length} waiting`)),
      rows.length === 0
        ? el("div", { class: "panel" }, el("div", { class: "empty" }, el("strong", {}, "Queue is clear"), "Versions written by client tokens land here before agents can see them."))
        : el("table", { class: "ledger" },
            el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Skill"), el("th", {}, "Version"), el("th", {}, "Author token"), el("th", {}, "Lint"), el("th", { class: "right" }, "Actions"))),
            el("tbody", {}, ...rows.map((r, i) => el("tr", {},
              el("td", { class: "idx" }, String(i + 1).padStart(2, "0")),
              el("td", { class: "name", style: "cursor:pointer", onclick: () => { state.skill = r.skill; state.page = "skills"; render(); } }, r.skill),
              el("td", { class: "num" }, r.semver),
              el("td", { class: "muted" }, r.token_name || "—"),
              el("td", { class: "num" }, String(r.lint_score)),
              el("td", { class: "right", style: "display:flex;gap:4px;justify-content:flex-end" },
                el("button", { class: "btn small primary", onclick: async () => { await api(`/api/versions/${r.id}/approve`, { method: "POST", body: "{}" }); toast(`Approved ${r.skill} ${r.semver}`); render(); } }, "Approve"),
                el("button", { class: "btn small danger", onclick: async () => { await api(`/api/versions/${r.id}/reject`, { method: "POST", body: "{}" }); toast(`Rejected ${r.skill} ${r.semver}`); render(); } }, "Reject")))))));
  } catch (e) { app.replaceChildren(errorPanel(e)); }
}

// ---------- taxonomy: categories + collections + tags, one aligned system ----------
async function viewTaxonomy(app) {
  app.replaceChildren(el("div", { class: "empty" }, "Reading taxonomy…"));
  try {
    const [cats, cols, tags, skills] = await Promise.all([api("/api/categories"), api("/api/collections"), api("/api/tags"), api("/api/skills")]);
    const nameOf = (id) => skills.find((s) => s.id === id)?.name || `#${id}`;
    // deep link into the Skills view with this grouping preselected
    const openCat = (id) => { sessionStorage.setItem("skills_filter_cat", String(id)); location.hash = "skills"; };
    const openTag = (t) => { sessionStorage.setItem("skills_filter_tag", t); location.hash = "skills"; };

    const catName = el("input", { type: "text", placeholder: "backend" });
    const addCat = async () => {
      try { await api("/api/categories", { method: "POST", body: JSON.stringify({ name: catName.value.trim() }) }); catName.value = ""; toast("Category added"); render(); }
      catch (e) { toast(e.message, true); }
    };
    const colName = el("input", { type: "text", placeholder: "onboarding-pack" });
    const addCol = async () => {
      try { await api("/api/collections", { method: "POST", body: JSON.stringify({ name: colName.value.trim() }) }); colName.value = ""; toast("Collection added"); render(); }
      catch (e) { toast(e.message, true); }
    };
    const tagName = el("input", { type: "text", placeholder: "pdf" });
    const addTag = async () => {
      try { await api("/api/tags", { method: "POST", body: JSON.stringify({ name: tagName.value.trim() }) }); tagName.value = ""; toast("Tag added"); render(); }
      catch (e) { toast(e.message, true); }
    };

    // a category's member chips, aligned under the same anatomy as collections
    const catMembers = (c) => skills.filter((s) => s.category_id === c.id);
    const memberChips = (items) => items.length
      ? el("td", { class: "col-desc" }, el("div", { class: "chips" }, ...items.slice(0, 4).map((s) => el("button", { class: "chip link", onclick: () => { state.skill = s.name; state.page = "skills"; location.hash = "skills"; render(); } }, s.name)), items.length > 4 ? el("span", { class: "chip more" }, `+${items.length - 4}`) : ""))
      : el("td", { class: "col-desc muted" }, "—");
    const countCell = (n, onclick, title) => el("td", { class: "num right" },
      onclick && n > 0
        ? el("button", { class: "count-link num", onclick, title: title || `View the ${n} skill${n === 1 ? "" : "s"}` }, `${n} skill${n === 1 ? "" : "s"}`)
        : el("span", { class: "num muted" }, `${n} skill${n === 1 ? "" : "s"}`));

    const catRow = (c, i) => {
      const items = catMembers(c);
      return el("tr", {},
        el("td", { class: "idx" }, String(i + 1).padStart(2, "0")),
        el("td", { class: "name" }, c.name),
        memberChips(items),
        countCell(items.length, () => openCat(c.id)));
    };
    const colRow = (c, i) => el("tr", {},
      el("td", { class: "idx" }, String(i + 1).padStart(2, "0")),
      el("td", { class: "name" }, c.name),
      memberChips(c.skill_ids.map((id) => ({ id, name: nameOf(id) }))),
      countCell(c.skill_ids.length));
    const tagRow = (t, i) => el("tr", {},
      el("td", { class: "idx" }, String(i + 1).padStart(2, "0")),
      el("td", {}, el("button", { class: "chip link", onclick: () => openTag(t.name) }, t.name)),
      memberChips(skills.filter((s) => (s.tags || []).includes(t.name)).map((s) => ({ id: s.id, name: s.name }))),
      countCell(t.skill_count, () => openTag(t.name)));

    app.replaceChildren(
      el("div", { class: "page-head" }, el("h1", {}, "Taxonomy"), el("span", { class: "count" }, "the units you file and assign skills with")),
      el("div", { class: "panel" },
        el("h2", {}, "Categories"),
        el("p", { class: "muted", style: "margin:4px 0 16px" }, "The filing system — every skill sits in exactly one category. Assigning a category to a token grants all of its skills."),
        el("div", { class: "form-row" }, el("div", {}, el("label", {}, "New category"), catName), el("button", { class: "btn primary", onclick: addCat }, "Add")),
        cats.length === 0 ? el("div", { class: "empty" }, el("strong", {}, "No categories yet"), "Add one above, or let the AI desk sort skills for you.") :
        el("table", { class: "ledger" },
          el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Category"), el("th", { class: "col-desc" }, "Skills"), el("th", { class: "right" }, "Count"))),
          el("tbody", {}, ...cats.map(catRow)))),
      el("div", { class: "split" },
        el("div", { class: "panel" }, el("h2", {}, "Collections"),
          el("p", { class: "muted", style: "margin:4px 0 16px" }, "Named bundles across categories — assign a whole pack to a token as one unit, or serve it as a single .tgz archive."),
          el("div", { class: "form-row" }, el("div", {}, el("label", {}, "New collection"), colName), el("button", { class: "btn primary", onclick: addCol }, "Add")),
          cols.length === 0 ? el("div", { class: "empty" }, el("strong", {}, "No collections yet"), "A collection is a named bundle of skills you assign as one unit.") :
          el("table", { class: "ledger" },
            el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Collection"), el("th", { class: "col-desc" }, "Skills"), el("th", { class: "right" }, "Count"))),
            el("tbody", {}, ...cols.map(colRow)))),
        el("div", { class: "panel" }, el("h2", {}, "Tags"),
          el("p", { class: "muted", style: "margin:4px 0 16px" }, "Cross-cutting labels — a skill can carry many, and agents can search by them over MCP."),
          el("div", { class: "form-row" }, el("div", {}, el("label", {}, "New tag"), tagName), el("button", { class: "btn primary", onclick: addTag }, "Add")),
          tags.length === 0 ? el("div", { class: "empty" }, el("strong", {}, "No tags yet"), "Tags like pdf or onboarding cut across categories.") :
          el("table", { class: "ledger" },
            el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Tag"), el("th", { class: "col-desc" }, "Skills"), el("th", { class: "right" }, "Count"))),
            el("tbody", {}, ...tags.map(tagRow))))),
    );
  } catch (e) { app.replaceChildren(errorPanel(e)); }
}
// ---------- tokens + assignment matrix ----------
async function viewTokens(app) {
  if (state.token) return viewTokenDetail(app, state.token);
  app.replaceChildren(el("div", { class: "empty" }, "Reading tokens…"));
  try {
    const [tokens, cats, cols, skills] = await Promise.all([api("/api/tokens"), api("/api/categories"), api("/api/collections"), api("/api/skills")]);
    const name = el("input", { type: "text", placeholder: "proj-alpha" });
    const writeScope = el("input", { type: "checkbox" });
    const created = el("div");
    const create = async () => {
      try {
        const r = await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: name.value.trim(), scopes: writeScope.checked ? ["skills:read", "skills:write"] : ["skills:read"] }) });
        created.replaceChildren(el("div", { class: "notice" },
          el("strong", {}, "Token created — copy it now, it is shown once."),
          el("pre", { class: "code", style: "margin-top:8px" }, r.token)));
        name.value = "";
        const fresh = await api("/api/tokens");
        tableBody.replaceChildren(...tokenRows(fresh));
      } catch (e) { toast(e.message, true); }
    };
    const tokenRows = (list) => list.map((t, i) => el("tr", { class: "row", tabindex: "0", onclick: () => { state.token = t.id; render(); }, onkeydown: (e) => { if (e.key === "Enter") { state.token = t.id; render(); } } },
      el("td", { class: "idx" }, String(i + 1).padStart(2, "0")),
      el("td", { class: "name" }, t.name),
      el("td", { class: "num" }, t.prefix + "…"),
      el("td", { class: "num" }, t.scopes.join(" + ")),
      el("td", {}, t.revoked_at ? el("span", { class: "pill deprecated" }, "revoked") : el("span", { class: "pill published" }, "active")),
      el("td", { class: "num right" }, t.last_used_at || "never")));
    const tableBody = el("tbody", {}, ...tokenRows(tokens));

    app.replaceChildren(
      el("div", { class: "page-head" }, el("h1", {}, "Client tokens"), el("span", { class: "count" }, `${tokens.length} issued`)),
      el("div", { class: "panel" },
        el("h2", {}, "Issue a token"),
        el("div", { class: "form-row" }, el("div", {}, el("label", {}, "Client name"), name),
          el("div", { class: "checkline", style: "flex:0 0 auto" }, el("label", {}, writeScope, "allow writing skills")),
          el("button", { class: "btn primary", onclick: create }, "Issue")),
        created),
      el("div", { class: "panel" }, el("h2", {}, "Issued"),
        tokens.length === 0 ? el("div", { class: "empty" }, el("strong", {}, "No tokens yet"), "Issue one per project or machine, then assign what it may see.") :
        el("table", { class: "ledger" },
          el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Client"), el("th", {}, "Prefix"), el("th", {}, "Scopes"), el("th", {}, "State"), el("th", { class: "right" }, "Last used"))),
          tableBody)),
    );
  } catch (e) { app.replaceChildren(errorPanel(e)); }
}

async function viewTokenDetail(app, tokenId) {
  app.replaceChildren(el("div", { class: "empty" }, "Reading token…"));
  try {
    const [tokens, assigns, preview, cats, cols] = await Promise.all([
      api("/api/tokens"), api(`/api/tokens/${tokenId}/assignments`), api(`/api/tokens/${tokenId}/preview`), api("/api/categories"), api("/api/collections"),
    ]);
    const skills = await api("/api/skills");
    const tok = tokens.find((t) => t.id === tokenId);
    const kind = el("select", {}, el("option", { value: "category" }, "category"), el("option", { value: "collection" }, "collection"), el("option", { value: "skill" }, "skill"));
    const target = el("select");
    const pin = el("select", {}, el("option", { value: "latest" }, "latest"), el("option", { value: "major:1" }, "pin major 1"), el("option", { value: "major:2" }, "pin major 2"), el("option", { value: "exact" }, "exact version…"));
    const exact = el("input", { type: "text", placeholder: "1.0.0", style: "display:none;max-width:110px" });
    pin.addEventListener("change", () => { exact.style.display = pin.value === "exact" ? "" : "none"; });
    const fillTargets = () => {
      const opts = kind.value === "category" ? cats.map((c) => [c.id, c.name]) : kind.value === "collection" ? cols.map((c) => [c.id, c.name]) : skills.map((s) => [s.id, s.name]);
      target.replaceChildren(...opts.map(([id, label]) => el("option", { value: id }, label)));
    };
    fillTargets();
    kind.addEventListener("change", fillTargets);

    const assign = async () => {
      const p = pin.value === "exact" ? `exact:${exact.value.trim()}` : pin.value;
      try {
        await api(`/api/tokens/${tokenId}/assignments`, { method: "PUT", body: JSON.stringify({ kind: kind.value, target_id: Number(target.value), pin: p }) });
        toast("Assignment saved"); render();
      } catch (e) { toast(e.message, true); }
    };

    const revoke = async () => {
      const ok = await confirmDialog(`Revoke '${tok.name}'?`, "Any agent using it stops working immediately.", "Revoke token");
      if (!ok) return;
      await api(`/api/tokens/${tokenId}`, { method: "DELETE", body: "{}" });
      toast("Token revoked"); go("tokens");
    };

    const assignRows = assigns.map((a) =>
      el("tr", {},
        el("td", { class: "muted" }, a.kind),
        el("td", { class: "name" }, a.target_name || "#" + a.target_id),
        el("td", { class: "num" }, a.pin),
        el("td", { class: "right" },
          el("button", { class: "btn small danger", onclick: async () => {
            await api("/api/tokens/" + tokenId + "/assignments/" + a.id, { method: "DELETE" });
            toast("Assignment removed");
            render();
          } }, "Remove"))));

    const assignPanel = el("div", { class: "panel" },
      el("h2", {}, "Assignments"),
      el("div", { class: "form-row" },
        el("div", {}, el("label", {}, "Grant"), kind),
        el("div", {}, el("label", {}, "Target"), target),
        el("div", { style: "flex:0 0 130px" }, el("label", {}, "Version policy"), pin),
        exact,
        el("button", { class: "btn primary", onclick: assign }, "Assign")),
      assigns.length === 0
        ? el("div", { class: "empty" }, el("strong", {}, "Nothing assigned"), "This token currently sees no skills.")
        : el("table", { class: "ledger" },
            el("thead", {}, el("tr", {}, el("th", {}, "Kind"), el("th", {}, "Target"), el("th", {}, "Version policy"), el("th", {}, ""))),
            el("tbody", {}, ...assignRows)));

    const previewRows = preview.map((p, i) =>
      el("tr", {},
        el("td", { class: "idx" }, String(i + 1).padStart(2, "0")),
        el("td", { class: "name" }, p.name),
        el("td", { class: "num" }, p.semver),
        el("td", { class: "num right" }, p.pin)));

    const previewPanel = el("div", { class: "panel" },
      el("h2", {}, "What this token sees"),
      preview.length === 0
        ? el("div", { class: "empty" }, el("strong", {}, "Nothing yet"), "Assign a category, collection or individual skill above.")
        : el("table", { class: "ledger" }, el("tbody", {}, ...previewRows)));

    app.replaceChildren(
      el("div", { class: "page-head" }, el("h1", { class: "mono" }, tok.name), tok.revoked_at ? el("span", { class: "pill deprecated" }, "revoked") : el("span", { class: "pill published" }, "active"),
        el("div", { class: "actions" }, el("button", { class: "btn", onclick: () => go("tokens") }, "Back to tokens"))),
      el("div", { class: "split" }, assignPanel, previewPanel),
      el("div", { class: "panel" },
        el("h2", {}, "Connect an agent"),
        el("p", { class: "muted", style: "margin-top:0" }, "The token value is only shown at creation. If it is lost, revoke this token and issue a new one."),
        el("div", { class: "snippet", style: "margin-bottom:16px" },
          el("label", {}, "Claude Code / pi (MCP)"),
          el("pre", { class: "code" }, `claude mcp add skills-hub --transport http \\\n  --header "Authorization: Bearer ct_…" \\\n  ${location.origin}/mcp`),
          el("button", { class: "btn small", onclick: (e) => { navigator.clipboard.writeText(`claude mcp add skills-hub --transport http --header "Authorization: Bearer ct_…" ${location.origin}/mcp`); toast("Copied"); } }, "Copy")),
        el("div", { class: "snippet" },
          el("label", {}, "npx skills (direct install)"),
          el("pre", { class: "code" }, `npx skills add ${location.origin}/s/<skill-name>.tgz`),
          el("button", { class: "btn small", onclick: (e) => { navigator.clipboard.writeText(`npx skills add ${location.origin}/s/<skill-name>.tgz`); toast("Copied"); } }, "Copy")),
        el("button", { class: "btn danger", style: "margin-top:16px", onclick: revoke }, "Revoke this token"),
      ),
    );
  } catch (e) { app.replaceChildren(errorPanel(e), el("button", { class: "btn", onclick: () => go("tokens") }, "Back")); }
}

// ---------- sources ----------
async function viewSources(app) {
  app.replaceChildren(el("div", { class: "empty" }, "Reading sources…"));
  try {
    const [sources] = await Promise.all([api("/api/sources")]);
    const url = el("input", { type: "text", placeholder: "vercel-labs/agent-skills  ·  https://github.com/o/r/tree/main/skills/x  ·  /local/path" });
    const hours = el("input", { type: "number", placeholder: "24", min: "1" });
    const report = el("div");

    const preview = async () => {
      report.replaceChildren(el("div", { class: "empty" }, "Fetching and scanning…"));
      try {
        const rows = await api("/api/import/preview", { method: "POST", body: JSON.stringify({ url: url.value.trim() }) });
        report.replaceChildren(
          el("h3", {}, `Preview — ${rows.length} skills found, nothing stored`),
          el("table", { class: "ledger" },
            el("thead", {}, el("tr", {}, el("th", {}, "Skill"), el("th", {}, "Version"), el("th", {}, "Files"), el("th", { class: "right" }, "Security"))),
            el("tbody", {}, ...rows.map((r) => el("tr", {},
              el("td", { class: "name" }, r.name),
              el("td", { class: "num" }, r.version || "auto"),
              el("td", { class: "num" }, `${r.files.length} files`),
              el("td", { class: "right" }, r.security_flags.length ? el("span", { class: "pill flag", title: r.security_flags.join("\n") }, `${r.security_flags.length} flags`) : el("span", { class: "pill published" }, "clean")))))),
          el("button", { class: "btn primary", style: "margin-top:16px", onclick: run }, `Import these ${rows.length} skills`));
      } catch (e) { report.replaceChildren(el("div", { class: "error-banner" }, e.message)); }
    };
    const run = async () => {
      try {
        const r = await api("/api/import/run", { method: "POST", body: JSON.stringify({ url: url.value.trim() }) });
        report.replaceChildren(el("div", { class: "notice" }, r.items.map((i) => `${i.skill}: ${i.action}${i.semver ? " " + i.semver : ""}${i.pending ? " (needs approval)" : ""}`).join(" · ")));
        const fresh = await api("/api/sources");
        body.replaceChildren(...sourceRows(fresh));
      } catch (e) { toast(e.message, true); }
    };
    const addSource = async () => {
      try {
        await api("/api/sources", { method: "POST", body: JSON.stringify({ url: url.value.trim(), auto_refresh_hours: hours.value ? Number(hours.value) : null }) });
        toast("Source added"); render();
      } catch (e) { toast(e.message, true); }
    };
    const sourceRows = (list) => list.map((s, i) => el("tr", {},
      el("td", { class: "idx" }, String(i + 1).padStart(2, "0")),
      el("td", { class: "name", title: s.url }, s.url.length > 52 ? s.url.slice(0, 52) + "…" : s.url),
      el("td", { class: "num" }, s.kind),
      el("td", { class: "num" }, s.auto_refresh_hours ? `${s.auto_refresh_hours}h` : "manual"),
      el("td", { class: "num" }, s.last_status || "never run"),
      el("td", { class: "right", style: "display:flex;gap:4px;justify-content:flex-end" },
        el("button", { class: "btn small", onclick: async () => { try { await api(`/api/sources/${s.id}/run`, { method: "POST", body: "{}" }); toast("Imported"); render(); } catch (e) { toast(e.message, true); } } }, "Run now"),
        el("button", { class: "btn small danger", onclick: async () => { await api(`/api/sources/${s.id}`, { method: "DELETE" }); toast("Removed"); render(); } }, "Remove"))));
    const body = el("tbody", {}, ...sourceRows(sources));

    app.replaceChildren(
      el("div", { class: "page-head" }, el("h1", {}, "Sources"), el("span", { class: "count" }, "pull skills from git, URLs or disk")),
      el("div", { class: "panel" },
        el("h2", {}, "Import from a source"),
        el("div", { class: "form-row" }, el("div", {}, el("label", {}, "Source (owner/repo, GitHub/GitLab URL, .tgz URL, or local path)"), url), el("div", { style: "flex:0 0 130px" }, el("label", {}, "Auto-refresh (hours)"), hours)),
        el("div", { class: "checkline", style: "gap:8px" },
          el("button", { class: "btn", onclick: preview }, "Preview only"),
          el("button", { class: "btn primary", onclick: run }, "Import now"),
          el("button", { class: "btn", onclick: addSource }, "Save as recurring source")),
        renderSecurityNote(),
        report),
      el("div", { class: "panel" }, el("h2", {}, "Recurring sources"),
        sources.length === 0 ? el("div", { class: "empty" }, el("strong", {}, "No saved sources"), "Save a repo as a source to re-import it on a schedule.") :
        el("table", { class: "ledger" },
          el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Source"), el("th", {}, "Kind"), el("th", {}, "Refresh"), el("th", {}, "Last run"), el("th", { class: "right" }, "Actions"))),
          body)),
    );
  } catch (e) { app.replaceChildren(errorPanel(e)); }
}

function renderSecurityNote() {
  return el("p", { class: "muted", style: "font-size:0.8125rem;margin:16px 0 0" },
    "Every import is scanned before it lands: malformed frontmatter is rejected, and prompt-injection or credential patterns force the skill to draft with the flags shown on its record.");
}

// ---------- AI desk ----------
async function viewAi(app) {
  app.replaceChildren(el("div", { class: "empty" }, "Reading jobs…"));
  try {
    const [jobs, stats] = await Promise.all([api("/api/ai/jobs"), api("/api/stats")]);
    const aiReady = stats.ai_configured === true;
    const detail = el("div");
    const run = async (kind) => {
      try {
        await api("/api/ai/jobs", { method: "POST", body: JSON.stringify({ kind }) });
        toast("Job queued — it runs in the background"); render();
      } catch (e) { toast(e.message, true); }
    };
    const openJob = async (id) => {
      detail.replaceChildren(el("div", { class: "empty" }, "Reading result…"));
      try {
        const job = await api(`/api/ai/jobs/${id}`);
        detail.replaceChildren(renderJobResult(job));
      } catch (e) { detail.replaceChildren(errorPanel(e)); }
    };
    app.replaceChildren(
      el("div", { class: "page-head" }, el("h1", {}, "AI desk"), el("span", { class: "count" }, "advisory only — nothing changes until you apply it")),
      el("div", { class: "panel" },
        el("h2", {}, "Run a job"),
        aiReady
          ? el("p", { class: "muted", style: "margin-top:0" }, "Suggestions are proposals; apply them explicitly. Nothing changes until you do.")
          : el("div", { class: "error-banner", style: "margin-bottom:16px" },
              "AI is not configured on this server. Set AI_BASE_URL to an OpenAI-compatible endpoint (Ollama works: http://localhost:11434/v1) and restart. Everything else in the hub works without it."),
        el("div", { class: "checkline", style: "gap:8px" },
          el("button", { class: "btn primary", disabled: !aiReady, title: aiReady ? null : "AI_BASE_URL is not set", onclick: () => run("categorize") }, "Sort into categories"),
          el("button", { class: "btn", disabled: !aiReady, title: aiReady ? null : "AI_BASE_URL is not set", onclick: () => run("dedupe_review") }, "Review duplicates"),
          el("button", { class: "btn", disabled: !aiReady, title: aiReady ? null : "AI_BASE_URL is not set", onclick: () => run("improve_descriptions") }, "Improve descriptions"))),
      el("div", { class: "panel" }, el("h2", {}, "Jobs"),
        jobs.length === 0 ? el("div", { class: "empty" }, el("strong", {}, "No jobs yet"), "Run one above; results appear here with an Apply action.") :
        el("table", { class: "ledger" },
          el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Job"), el("th", {}, "State"), el("th", { class: "right" }, "When"))),
          el("tbody", {}, ...jobs.map((j, i) => el("tr", { class: "row", tabindex: "0", onclick: () => openJob(j.id), onkeydown: (e) => { if (e.key === "Enter") openJob(j.id); } },
            el("td", { class: "idx" }, String(i + 1).padStart(2, "0")),
            el("td", { class: "mono" }, j.kind.replace(/_/g, " ")),
            el("td", {}, pill(j.status === "done" ? "published" : j.status === "error" ? "flag" : "pending")),
            el("td", { class: "num right" }, j.created_at)))))),
      detail,
    );
  } catch (e) { app.replaceChildren(errorPanel(e)); }
}

function renderJobResult(job) {
  const panel = el("div", { class: "panel" }, el("h2", {}, `Result — ${job.kind.replace(/_/g, " ")}`));
  if (job.status !== "done") { panel.append(el("div", { class: "empty" }, job.status === "error" ? `Failed: ${job.error}` : `Job is ${job.status}.`)); return panel; }
  const r = job.result || {};
  if (r.suggestions?.length) {
    const applyButton = (s) => {
      if (s.category) {
        return el("button", { class: "btn small primary", onclick: async () => {
          try {
            await api("/api/ai/apply/categorize", { method: "POST",
              body: JSON.stringify({ skill: s.skill, category: s.category, create: !!s.new_category }) });
            toast("Filed " + s.skill + " under " + s.category);
          } catch (e) { toast(e.message, true); }
        } }, "Apply");
      }
      if (s.description) {
        return el("button", { class: "btn small primary", onclick: async () => {
          try {
            await api("/api/ai/apply/description", { method: "POST",
              body: JSON.stringify({ version_id: s.version_id, description: s.description }) });
            toast("Description updated for " + s.skill);
          } catch (e) { toast(e.message, true); }
        } }, "Apply");
      }
      return "";
    };
    const rows = r.suggestions.map((s) =>
      el("tr", {},
        el("td", { class: "name" }, s.skill),
        el("td", { style: "white-space:normal" }, s.description || s.category || s.error || "—"),
        el("td", { class: "right" }, applyButton(s))));
    panel.append(el("table", { class: "ledger" },
      el("thead", {}, el("tr", {}, el("th", {}, "Skill"), el("th", {}, "Suggestion"), el("th", { class: "right" }, ""))),
      el("tbody", {}, ...rows)));
  } else if (r.duplicates?.length) {
    panel.append(el("table", { class: "ledger" },
      el("thead", {}, el("tr", {}, el("th", {}, "Skill A"), el("th", {}, "Skill B"), el("th", {}, "Why"))),
      el("tbody", {}, ...r.duplicates.map((d) => el("tr", {}, el("td", { class: "name" }, d.skill_a), el("td", { class: "name" }, d.skill_b), el("td", { style: "white-space:normal" }, d.reason))))));
  } else {
    panel.append(el("div", { class: "empty" }, el("strong", {}, "Nothing to change"), `Compared ${r.compared ?? 0} pairs; no suggestions came back.`));
  }
  return panel;
}

// ---------- audit ----------
async function viewAudit(app) {
  app.replaceChildren(el("div", { class: "empty" }, "Reading the log…"));
  try {
    const rows = await api("/api/audit?limit=200");
    app.replaceChildren(
      el("div", { class: "page-head" }, el("h1", {}, "Audit log"), el("span", { class: "count" }, `${rows.length} entries`)),
      rows.length === 0 ? el("div", { class: "panel" }, el("div", { class: "empty" }, el("strong", {}, "The log is empty"), "Every publish, approval and assignment is recorded here.")) :
      el("table", { class: "ledger" },
        el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Action"), el("th", {}, "Actor"), el("th", {}, "Detail"), el("th", { class: "right" }, "When"))),
        el("tbody", {}, ...rows.map((a, i) => el("tr", {},
          el("td", { class: "idx" }, String(i + 1).padStart(2, "0")),
          el("td", { class: "mono" }, a.action),
          el("td", { class: "muted" }, `${a.actor_kind}${a.actor_id ? " #" + a.actor_id : ""}`),
          el("td", { class: "desc" }, a.detail_json),
          el("td", { class: "num right" }, a.ts))))),
    );
  } catch (e) { app.replaceChildren(errorPanel(e)); }
}

// boot
const initial = location.hash.replace("#", "");
if (PAGES.some(([id]) => id === initial)) state.page = initial;
render();
window.addEventListener("hashchange", () => {
  const p = location.hash.replace("#", "");
  if (PAGES.some(([id]) => id === p) && p !== state.page) { state.page = p; state.skill = null; state.token = null; render(); }
});
