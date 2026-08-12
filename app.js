"use strict";
/* StockConnect Terrain — app PWA, aucune dépendance serveur. */

const LS_CFG = "sc_cfg";
const LS_STATE = "sc_state";
const LS_QUEUE = "sc_queue";

const $ = (id) => document.getElementById(id);
const APP_VERSION = "1.0.0";

const cfg = {
  entite: localStorage.getItem(LS_CFG + "_entite") || "",
  resto: localStorage.getItem(LS_CFG + "_resto") || "",
  restoNom: localStorage.getItem(LS_CFG + "_resto_nom") || "",
  broker: localStorage.getItem(LS_CFG + "_broker") || "wss://broker.emqx.io:8084/mqtt",
  seuilDefaut: Number(localStorage.getItem(LS_CFG + "_seuil") || 10),
};

let client = null;
let etat = { articles: {}, maj: 0 };
let pending = JSON.parse(localStorage.getItem(LS_QUEUE) || "[]");
let sens = "in";

function chargerEtat() {
  try { etat = JSON.parse(localStorage.getItem(LS_STATE)) || etat; } catch (e) { etat = { articles: {}, maj: 0 }; }
}

function sauverEtat() {
  etat.maj = Date.now();
  localStorage.setItem(LS_STATE, JSON.stringify(etat));
}

function sauverQueue() {
  localStorage.setItem(LS_QUEUE, JSON.stringify(pending));
  $("attente-nb").textContent = pending.length;
  $("file-attente").classList.toggle("cache", pending.length === 0);
}

/* ---------- Connexion MQTT ---------- */
function connecter() {
  if (client) { client.end(true); }
  setStatut("warn", "connexion…");
  client = mqtt.connect(cfg.broker, {
    clientId: "sc-terrain-" + cfg.entite + "-" + cfg.resto + "-" + Math.random().toString(16).slice(2, 8),
    keepalive: 30,
    reconnectPeriod: 4000,
    connectTimeout: 10000,
  });

  client.on("connect", () => {
    setStatut("ok", "connecté");
    client.subscribe("stockconnect/" + cfg.entite + "/resto/" + cfg.resto + "/sync/state");
    envoyerHeartbeat();
    demanderSync();
    viderFileAttente();
  });

  client.on("reconnect", () => setStatut("warn", "reconnexion…"));
  client.on("close", () => setStatut("ko", "déconnecté"));
  client.on("error", (e) => { setStatut("ko", "erreur"); console.warn("mqtt", e); });

  client.on("message", (topic, payload) => {
    if (topic.endsWith("/sync/state")) recevoirEtat(payload.toString());
  });
}

function setStatut(etatPoint, texte) {
  $("point").className = "point " + etatPoint;
  $("statut-txt").textContent = texte;
}

function topicBase() {
  return "stockconnect/" + cfg.entite + "/resto/" + cfg.resto;
}

function envoyerHeartbeat() {
  publier("heartbeat", { resto: cfg.restoNom || "Resto " + cfg.resto, ts: Date.now(), par: "terrain", version: APP_VERSION });
}

function demanderSync() {
  publier("sync/request", { dev: "terrain-" + cfg.resto });
  $("sync-info").textContent = "demande de synchronisation…";
}

function publier(suffixe, objet) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(Object.assign({ ts: Date.now() }, objet));
    if (!client || !client.connected) { reject(new Error("hors-ligne")); return; }
    client.publish(topicBase() + "/" + suffixe, payload, { qos: 1 }, (err) => err ? reject(err) : resolve());
  });
}

function recevoirEtat(payloadJson) {
  try {
    const reponse = JSON.parse(payloadJson);
    if (!reponse.articles) return;
    let nouveaux = 0;
    for (const a of reponse.articles) {
      if (!a.ref) continue;
      const ancien = etat.articles[a.ref] || {};
      const absent = !(a.ref in etat.articles);
      const qteChangee = Number(ancien.qte ?? -1) !== Number(a.qte);
      if (absent || qteChangee || Number(ancien.seuil_min) !== Number(a.seuil_min)) {
        etat.articles[a.ref] = { ref: a.ref, design: a.design || a.ref, qte: Number(a.qte) || 0, seuil_min: a.seuil_min ?? cfg.seuilDefaut, ts: a.ts || Date.now() };
        nouveaux++;
      }
    }
    for (const ref of Object.keys(etat.articles)) {
      if (!reponse.articles.some((a) => a.ref === ref)) delete etat.articles[ref];
    }
    sauverEtat();
    $("sync-info").textContent = nouveaux + " article(s) mis à jour à " + new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    rafraichir(true);
    toast("Synchronisation OK");
  } catch (e) {
    console.warn("état invalide", e);
  }
}

/* ---------- File d'attente hors-ligne ---------- */
function mettreEnFile(suffixe, objet) {
  pending.push({ suffixe, objet: Object.assign({ dev: "terrain-" + cfg.resto }, objet) });
  sauverQueue();
}

async function viderFileAttente() {
  if (!client || !client.connected || pending.length === 0) return;
  const attente = pending;
  pending = [];
  sauverQueue();
  let ok = 0;
  for (const item of attente) {
    try { await publier(item.suffixe, item.objet); ok++; }
    catch (e) { pending.push(item); sauverQueue(); break; }
  }
  if (ok) toast(ok + " mouvement(s) envoyé(s) depuis la file d'attente");
  if (pending.length) toast(pending.length + " mouvement(s) restent en attente");
}

/* ---------- Mouvements ---------- */
function envoyerMouvement(ref, monSens, qte, motif) {
  const message = { ref, sens: monSens, qte: Number(qte), motif: motif || "" };
  if (!ref) { toast("Choisissez un article"); return; }
  if (!(qte > 0)) { toast("Quantité invalide"); return; }
  publier("mvt", message)
    .then(() => { appliquerLocal(message); toast("Mouvement envoyé ✓"); })
    .catch(() => { mettreEnFile("mvt", message); appliquerLocal(message); toast("Hors-ligne : mouvement mis en file d'attente"); });
}

function appliquerLocal(message) {
  const a = etat.articles[message.ref];
  if (!a) { toast("Article inconnu sur ce poste — synchronisez."); return; }
  if (message.sens === "in") a.qte += message.qte;
  else if (message.sens === "out") a.qte = Math.max(0, a.qte - message.qte);
  else if (message.sens === "set") a.qte = message.qte;
  sauverEtat();
  rafraichir(true);
}

function envoyerSeuil(ref, min) {
  const message = { ref, min: Number(min) };
  publier("seuil", message)
    .then(() => { etat.articles[ref].seuil_min = Number(min); sauverEtat(); toast("Seuil enregistré ✓"); refreshSeuils(); })
    .catch(() => toast("Hors-ligne : seuil non synchronisé"));
}

/* ---------- Gestion du catalogue ---------- */
function envoyerCatalogue(action, donnees) {
  const message = Object.assign({ action }, donnees);
  publier("catalogue", message)
    .then(() => { toast((action === "add" ? "Article ajouté" : "Article supprimé") + " ✓"); demanderSync(); })
    .catch(() => { mettreEnFile("catalogue", message); toast("Hors-ligne : opération mise en file d'attente"); });
}

function formArticle() {
  const vis = !$("form-article").classList.contains("cache");
  $("form-article").classList.toggle("cache", vis);
  $("btn-nouveau").textContent = vis ? "+ Nouvel article" : "Fermer le formulaire";
  if (!vis) { $("art-ref").value = ""; $("art-design").value = ""; $("art-qte").value = "0"; $("art-seuil").value = ""; }
}

function refreshGestion() {
  const articles = triArticles();
  if (!articles.length) {
    $("liste-gestion").innerHTML = '<p class="aide">Catalogue vide. Ajoutez votre premier article ci-dessus (il sera aussi disponible sur les autres postes).</p>';
    return;
  }
  $("liste-gestion").innerHTML =
    '<div class="ligne-gestion entete"><b>Réf.</b><b>Désignation</b><b>Seuil</b><b></b></div>' +
    articles.map((a) =>
      '<div class="ligne-gestion">' +
      '<span class="a-ref" title="' + echap(a.ref) + '">' + echap(a.ref) + '</span>' +
      '<input id="g-design-' + a.ref + '" value="' + echap(a.design || "") + '">' +
      '<input type="number" min="0" id="g-seuil-' + a.ref + '" value="' + (a.seuil_min ?? cfg.seuilDefaut) + '">' +
      '<span class="actions">' +
      '<button class="mini" data-ref="' + a.ref + '" data-act="maj">MàJ</button>' +
      '<button class="danger" data-ref="' + a.ref + '" data-act="del">Suppr</button>' +
      '</span></div>').join("");
  document.querySelectorAll("#liste-gestion button").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.dataset.act === "maj") {
        envoyerCatalogue("add", {
          ref: b.dataset.ref,
          design: $("g-design-" + b.dataset.ref).value,
          seuil_min: Number($("g-seuil-" + b.dataset.ref).value || 0),
        });
      } else if (confirm("Supprimer " + b.dataset.ref + " du catalogue ?")) {
        envoyerCatalogue("del", { ref: b.dataset.ref, tous: $("art-tous").checked });
        delete etat.articles[b.dataset.ref];
        sauverEtat();
        refreshGestion();
      }
    });
  });
}

/* ---------- Affichage ---------- */
const $liste = $("liste-articles");
const $seuils = $("liste-seuils");

function etatArticle(a) {
  if (a.qte <= 0) return "rupture";
  if (a.qte <= (a.seuil_min ?? cfg.seuilDefaut)) return "bas";
  return "ok";
}

function triArticles() {
  const liste = Object.values(etat.articles);
  const rang = { rupture: 0, bas: 1, ok: 2 };
  return liste.sort((x, y) => rang[etatArticle(x)] - rang[etatArticle(y)] || x.ref.localeCompare(y.ref));
}

function rafraichir(focus = false) {
  const filtre = ($("recherche").value || "").toLowerCase().trim();
  const articles = triArticles().filter((a) => !filtre || (a.ref + " " + a.design).toLowerCase().includes(filtre));
  $liste.innerHTML = articles.map((a) => {
    const etat = etatArticle(a);
    return '<div class="article ' + etat + '">' +
      '<div><div class="a-ref">' + echap(a.ref) + '</div><div class="a-design">' + echap(a.design || "") + '</div></div>' +
      '<div style="display:flex;align-items:center;gap:8px"><span class="a-qte">' + a.qte + '</span>' +
      '<span class="badge ' + etat + '">' + etat + '</span></div></div>';
  }).join("");
  if (!articles.length) $liste.innerHTML = '<div class="carte"><p class="aide">Aucun article. Cliquez sur <b>Synchroniser</b> ou attendez le prochain état envoyé par le central.</p></div>';
  remplirSelectMouvement();
}

function echap(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function remplirSelectMouvement() {
  const sel = $("mvt-ref");
  sel.innerHTML = '<option value="">— choisir —</option>' + triArticles().map((a) =>
    '<option value="' + a.ref + '">' + a.ref + (a.design ? " — " + a.design : "") + " (stock " + a.qte + ")</option>").join("");
  const a = etat.articles[sel.value];
  $("mvt-info").textContent = a ? "Stock actuel : " + a.qte + " — seuil : " + (a.seuil_min ?? cfg.seuilDefaut) : "";
}

function refreshSeuils() {
  $seuils.innerHTML =
    '<div class="entete-seuil"><span>Article</span><span>Seuil min</span><span></span></div>' +
    triArticles().map((a) =>
      '<div class="ligne-seuil"><span class="a-ref">' + echap(a.ref) + '</span>' +
      '<input type="number" min="0" id="seuil-' + a.ref + '" value="' + (a.seuil_min ?? cfg.seuilDefaut) + '">' +
      '<button class="mini" data-ref="' + a.ref + '">OK</button></div>').join("");
  document.querySelectorAll("#liste-seuils button").forEach((b) => b.addEventListener("click", () => {
    envoyerSeuil(b.dataset.ref, $("seuil-" + b.dataset.ref).value);
  }));
}

/* ---------- Navigation ---------- */
function montrer(vue) {
  document.querySelectorAll(".vue").forEach((s) => s.classList.add("cache"));
  $("vue-" + vue).classList.remove("cache");
  $("nav").classList.remove("cache");
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("actif", b.dataset.vue === vue));
  if (vue === "stock") rafraichir();
  if (vue === "alarmes") refreshSeuils();
  if (vue === "gestion") refreshGestion();
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.classList.remove("cache");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("cache"), 3200);
}

/* ---------- Remplissage config + démarrage ---------- */
function remplirConfig() {
  $("cfg-entite").value = cfg.entite;
  $("cfg-resto").value = cfg.resto;
  $("cfg-resto-nom").value = cfg.restoNom;
  $("cfg-broker").value = cfg.broker;
  $("cfg-seuil").value = cfg.seuilDefaut;
}

function estConfigure() { return cfg.entite && cfg.resto; }

function demarrer() {
  chargerEtat();
  remplirConfig();
  $("recherche").addEventListener("input", () => rafraichir());

  document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => montrer(b.dataset.vue)));

  $("btn-save-cfg").addEventListener("click", () => {
    cfg.entite = $("cfg-entite").value.trim().replace(/\s+/g, "-").toLowerCase();
    cfg.resto = String(Number($("cfg-resto").value) || "").trim();
    cfg.restoNom = $("cfg-resto-nom").value.trim() || ("Resto " + cfg.resto);
    cfg.broker = $("cfg-broker").value.trim() || "wss://broker.emqx.io:8084/mqtt";
    cfg.seuilDefaut = Number($("cfg-seuil").value || 10);
    if (!cfg.entite || !cfg.resto) { toast("Entité et restaurent requis"); return; }
    localStorage.setItem(LS_CFG + "_entite", cfg.entite);
    localStorage.setItem(LS_CFG + "_resto", cfg.resto);
    localStorage.setItem(LS_CFG + "_resto_nom", cfg.restoNom);
    localStorage.setItem(LS_CFG + "_broker", cfg.broker);
    localStorage.setItem(LS_CFG + "_seuil", String(cfg.seuilDefaut));
    $("resto-label").textContent = cfg.restoNom;
    connecter();
    montrer("stock");
  });

  $("btn-sync").addEventListener("click", () => { demanderSync(); viderFileAttente(); });
  $("btn-vider").addEventListener("click", () => { pending = []; sauverQueue(); });

  $("btn-nouveau").addEventListener("click", formArticle);
  $("btn-art-cancel").addEventListener("click", formArticle);
  $("btn-art-add").addEventListener("click", () => {
    const ref = $("art-ref").value.trim().toUpperCase();
    if (!ref) { toast("Référence obligatoire"); return; }
    envoyerCatalogue("add", {
      ref,
      design: $("art-design").value.trim(),
      qte: Number($("art-qte").value || 0),
      seuil_min: ($("art-seuil").value !== "") ? Number($("art-seuil").value) : undefined,
      tous: $("art-tous").checked,
    });
    formArticle();
  });

  ["sens-in", "sens-out", "sens-set"].forEach((id) => $("sens-" + id.slice(5)).addEventListener("click", () => {
    sens = id.slice(5);
    document.querySelectorAll(".sens").forEach((s) => s.classList.toggle("actif", s.id === id));
  }));
  $("sens-out").textContent = "− Sortie";
  $("mvt-ref").addEventListener("change", remplirSelectMouvement);
  $("btn-mvt").addEventListener("click", () => envoyerMouvement($("mvt-ref").value, sens, $("mvt-qte").value, $("mvt-motif").value));

  if (estConfigure()) {
    $("resto-label").textContent = cfg.restoNom;
    rafraichir();
    montrer("stock");
    connecter();
  } else {
    montrer("config");
  }
}

document.addEventListener("DOMContentLoaded", demarrer);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}