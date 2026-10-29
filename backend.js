/*
  학급방 데이터 연결 (Firebase 또는 체험 모드)
  - 교사는 구글 로그인, 학생은 익명 로그인으로 들어옵니다.
  - 교사의 이름과 사진은 로그인 직후 지우고, 메일 주소는 학급방·학생 기록 어디에도 저장하지 않습니다.
  - Firebase 연결 정보가 없으면 체험 모드: 이 브라우저 안에서만 방과 기록을 저장합니다.
  화면 코드는 window.Backend 만 사용합니다.
*/
(function () {
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FB_VER = "10.12.2";
function rand(n) {
  const a = new Uint32Array(n); (window.crypto || window.msCrypto).getRandomValues(a);
  let s = ""; for (let i = 0; i < n; i++) s += CODE_CHARS[a[i] % CODE_CHARS.length]; return s;
}
const makeCode = () => rand(6);
function normalizeCode(c) { return String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); }
function maskEmail(e) { e = String(e || ""); const i = e.indexOf("@"); return i > 0 ? e[0] + "***" + e.slice(i) : ""; }
const cfg = window.FIREBASE_CONFIG || {};
const useFirebase = !!(cfg.apiKey && cfg.projectId);

/* ---------------- 체험 모드 ---------------- */
function localBackend() {
  const KEY = "oweol-room-demo-db", ME = "oweol-room-demo-me", TID = "oweol-demo-teacher-id";
  const bus = new Set();
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { rooms: {} }; } catch (e) { return { rooms: {} }; } };
  const write = (db) => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} bus.forEach((f) => f()); };
  window.addEventListener("storage", (e) => { if (e.key === KEY) bus.forEach((f) => f()); });
  const tid = () => { try { return localStorage.getItem(TID); } catch (e) { return null; } };
  let me = null; try { me = JSON.parse(sessionStorage.getItem(ME)); } catch (e) {}
  const strip = (r) => { const x = Object.assign({}, r); delete x.students; delete x.owners; delete x.key; return x; };
  const owns = (r) => !!(r && tid() && r.owners && r.owners.indexOf(tid()) > -1);
  return {
    mode: "local",
    onTeacher(cb) { const t = tid(); cb(t ? { uid: t, masked: "체험용 교사" } : null); return () => {}; },
    async signInTeacher() { let t = tid(); if (!t) { t = "demo-" + rand(8); try { localStorage.setItem(TID, t); } catch (e) {} } return { uid: t, masked: "체험용 교사" }; },
    async signOutTeacher() { try { localStorage.removeItem(TID); } catch (e) {} },
    async signInTeacherFromHome() { return this.signInTeacher(); },
    onTeacherFromHome(cb) { const t = tid(); cb(t ? { uid: t } : null); return () => {}; },
    async deleteMyAccount() {
      const db = read(), me2 = tid();
      Object.keys(db.rooms).forEach((c) => { const r = db.rooms[c]; if (r.owners && r.owners.indexOf(me2) > -1) delete db.rooms[c]; });
      write(db); try { localStorage.removeItem(TID); } catch (e) {}
    },
    async createRoom(title) {
      const db = read(); let code; do { code = makeCode(); } while (db.rooms[code]);
      db.rooms[code] = { code: code, title: title, open: true, createdAt: Date.now(), createdBy: tid(), owners: [tid()], students: {} };
      write(db); return { code: code };
    },
    async isMyRoom(code) { return owns(read().rooms[code]); },
    watchMyRooms(cb) {
      const f = () => cb(Object.values(read().rooms).filter(owns).map(strip).sort((a, b) => b.createdAt - a.createdAt));
      bus.add(f); f(); return () => bus.delete(f);
    },
    watchRoom(code, cb) { const f = () => { const r = read().rooms[code]; cb(owns(r) ? strip(r) : null); }; bus.add(f); f(); return () => bus.delete(f); },
    watchStudents(code, cb) {
      const f = () => { const r = read().rooms[code]; cb(owns(r) ? Object.keys(r.students).map((id) => Object.assign({ id: id }, r.students[id])) : []); };
      bus.add(f); f(); const t = setInterval(f, 3000); return () => { bus.delete(f); clearInterval(t); };
    },
    async setRoomOpen(code, open) { const db = read(); if (owns(db.rooms[code])) { db.rooms[code].open = open; write(db); } },
    async deleteStudent(code, id) { const db = read(); if (owns(db.rooms[code])) { delete db.rooms[code].students[id]; write(db); } },
    async deleteRoom(code) { const db = read(); if (owns(db.rooms[code])) { delete db.rooms[code]; write(db); } },
    async joinRoom(code, number, nickname) {
      code = normalizeCode(code); const db = read(), r = db.rooms[code];
      if (!r) return { ok: false, error: "no_room" };
      if (!r.open) return { ok: false, error: "closed" };
      const id = "s" + rand(10);
      r.students[id] = { number: number, nickname: nickname, joinedAt: Date.now(), updatedAt: Date.now() }; write(db);
      me = { id: id, code: code }; try { sessionStorage.setItem(ME, JSON.stringify(me)); } catch (e) {}
      return { ok: true, code: code, title: r.title, id: id };
    },
    async push(code, data) {
      const db = read(), r = db.rooms[code];
      if (!r) return { ok: false, error: "no_room" };
      if (!r.open) return { ok: false, error: "closed" };
      if (!me || me.code !== code || !r.students[me.id]) return { ok: false, error: "not_joined" };
      r.students[me.id] = Object.assign({}, r.students[me.id], data, { updatedAt: Date.now() }); write(db); return { ok: true };
    },
    async leave() { me = null; try { sessionStorage.removeItem(ME); } catch (e) {} },
    async isJoined(code) { const r = read().rooms[code]; return !!(me && me.code === code && r && r.students[me.id]); }
  };
}

/* ---------------- Firebase ---------------- */
async function firebaseBackend() {
  const base = "https://www.gstatic.com/firebasejs/" + FB_VER + "/";
  const appMod = await import(base + "firebase-app.js");
  const A = await import(base + "firebase-auth.js");
  const F = await import(base + "firebase-firestore.js");
  // 교사 화면과 학생 화면이 같은 브라우저에서 로그인 상태를 나눠 쓰지 않도록 앱 이름을 나눔
  const role = /teacher\.html$/.test(location.pathname) ? "teacher" : "student";
  const app = appMod.initializeApp(cfg, "oweol-" + role);
  const auth = A.getAuth(app), db = F.getFirestore(app);
  if (cfg.useEmulator) {
    A.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    F.connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }
  await A.setPersistence(auth, A.browserLocalPersistence);
  await new Promise((res) => { const u = A.onAuthStateChanged(auth, () => { u(); res(); }); });
  // 첫 화면의 '선생님' 탭에서 로그인할 때 쓰는 교사용 칸(교사 화면과 같은 이름이라 로그인 상태가 이어짐).
  // 팝업은 버튼을 누른 순간에 바로 열어야 막히지 않으므로 미리 만들어 둠.
  let tAuth = null;
  if (role === "student") {
    const tApp = appMod.initializeApp(cfg, "oweol-teacher");
    tAuth = A.getAuth(tApp);
    if (cfg.useEmulator) A.connectAuthEmulator(tAuth, "http://127.0.0.1:9099", { disableWarnings: true });
    A.setPersistence(tAuth, A.browserLocalPersistence).catch(() => {});
  }
  const roomRef = (code) => F.doc(db, "rooms", code);
  const stuCol = (code) => F.collection(db, "rooms", code, "students");
  const ownerRef = (code, uid) => F.doc(db, "rooms", code, "owners", uid || auth.currentUser.uid);
  const ms = (t) => (t && t.toMillis ? t.toMillis() : t || 0);
  // 로그인 직후 구글에서 받아 온 이름과 사진을 계정에서 지움 (메일 주소만 남음)
  async function stripProfile(u) {
    try { if (u && (u.displayName || u.photoURL)) await A.updateProfile(u, { displayName: "", photoURL: "" }); } catch (e) { console.warn("이름·사진 지우기 실패", e); }
  }
  async function deleteRoomAll(code) {
    const uid = auth.currentUser.uid;
    const s = await F.getDocs(stuCol(code));
    for (let i = 0; i < s.docs.length; i += 400) { const b = F.writeBatch(db); s.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref)); await b.commit(); }
    await F.deleteDoc(roomRef(code)).catch(() => {});
    await F.deleteDoc(ownerRef(code, uid));
  }
  const errCode = (e) => (e && (e.code === "auth/admin-restricted-operation" || e.code === "auth/operation-not-allowed") ? "auth_off" : e && e.code === "permission-denied" ? "closed" : e && (e.code === "unavailable" || e.code === "auth/network-request-failed") ? "offline" : "error");
  return {
    mode: "firebase",
    onTeacher(cb) { return A.onAuthStateChanged(auth, (u) => { if (u && !u.isAnonymous) { stripProfile(u); cb({ uid: u.uid, masked: maskEmail(u.email) }); } else cb(null); }); },
    async signInTeacher() {
      const r = await A.signInWithPopup(auth, new A.GoogleAuthProvider());
      await stripProfile(r.user);
      return { uid: r.user.uid, masked: maskEmail(r.user.email) };
    },
    async signOutTeacher() { await A.signOut(auth); },
    signInTeacherFromHome() {
      if (!tAuth) return this.signInTeacher();
      return A.signInWithPopup(tAuth, new A.GoogleAuthProvider()).then((r) => stripProfile(r.user).then(() => ({ uid: r.user.uid })));
    },
    onTeacherFromHome(cb) { if (!tAuth) { cb(null); return () => {}; } return A.onAuthStateChanged(tAuth, (u) => cb(u && !u.isAnonymous ? { uid: u.uid } : null)); },
    // 내 계정 지우기: 내가 만든 방과 학생 기록을 모두 지운 뒤 계정(메일 주소)을 지움
    async deleteMyAccount() {
      const uid = auth.currentUser.uid;
      const mine = await F.getDocs(F.query(F.collectionGroup(db, "owners"), F.where("uid", "==", uid)));
      for (const d of mine.docs) await deleteRoomAll(d.data().code);
      try { await A.deleteUser(auth.currentUser); }
      catch (e) {
        if (e && e.code === "auth/requires-recent-login") { await A.reauthenticateWithPopup(auth.currentUser, new A.GoogleAuthProvider()); await A.deleteUser(auth.currentUser); }
        else throw e;
      }
    },
    async createRoom(title) {
      const uid = auth.currentUser.uid;
      for (let i = 0; i < 6; i++) {
        const code = makeCode();
        const snap = await F.getDoc(roomRef(code)).catch(() => null);
        if (snap && snap.exists()) continue;
        const b = F.writeBatch(db);
        b.set(roomRef(code), { code: code, title: title, open: true, createdAt: F.serverTimestamp(), createdBy: uid });
        b.set(ownerRef(code, uid), { uid: uid, code: code });
        await b.commit();
        return { code: code };
      }
      throw new Error("code");
    },
    async isMyRoom(code) { const d = await F.getDoc(ownerRef(code)).catch(() => null); return !!(d && d.exists()); },
    watchMyRooms(cb) {
      const q = F.query(F.collectionGroup(db, "owners"), F.where("uid", "==", auth.currentUser.uid));
      let gen = 0;
      return F.onSnapshot(q, async (s) => {
        const my = ++gen;
        const rooms = await Promise.all(s.docs.map((d) => F.getDoc(roomRef(d.data().code)).then((r) => (r.exists() ? Object.assign({}, r.data(), { createdAt: ms(r.data().createdAt) }) : null)).catch(() => null)));
        if (my === gen) cb(rooms.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt));
      }, () => cb([]));
    },
    watchRoom(code, cb) { return F.onSnapshot(roomRef(code), (d) => cb(d.exists() ? Object.assign({}, d.data(), { createdAt: ms(d.data().createdAt) }) : null), () => cb(null)); },
    watchStudents(code, cb) {
      return F.onSnapshot(stuCol(code), (s) => cb(s.docs.map((d) => { const x = d.data(); return Object.assign({ id: d.id }, x, { joinedAt: ms(x.joinedAt), updatedAt: ms(x.updatedAt) }); })), () => cb([]));
    },
    async setRoomOpen(code, open) { await F.updateDoc(roomRef(code), { open: open }); },
    async deleteStudent(code, id) { await F.deleteDoc(F.doc(db, "rooms", code, "students", id)); },
    async deleteRoom(code) { await deleteRoomAll(code); },
    async joinRoom(code, number, nickname) {
      code = normalizeCode(code);
      try {
        // 공용 기기에서 다음 학생이 앞 학생 기록을 덮어쓰지 않도록, 입장할 때마다 새 익명 계정을 씀
        if (auth.currentUser) await A.signOut(auth);
        await A.signInAnonymously(auth);
        const r = await F.getDoc(roomRef(code));
        if (!r.exists()) return { ok: false, error: "no_room" };
        if (!r.data().open) return { ok: false, error: "closed" };
        await F.setDoc(F.doc(db, "rooms", code, "students", auth.currentUser.uid), { number: number, nickname: nickname, joinedAt: F.serverTimestamp(), updatedAt: F.serverTimestamp() });
        return { ok: true, code: code, title: r.data().title, id: auth.currentUser.uid };
      } catch (e) { console.error(e); return { ok: false, error: errCode(e) }; }
    },
    async push(code, data) {
      if (!auth.currentUser) return { ok: false, error: "not_joined" };
      try { await F.setDoc(F.doc(db, "rooms", code, "students", auth.currentUser.uid), Object.assign({}, data, { updatedAt: F.serverTimestamp() }), { merge: true }); return { ok: true }; }
      catch (e) { console.error(e); return { ok: false, error: errCode(e) }; }
    },
    async leave() { if (auth.currentUser) await A.signOut(auth); },
    async isJoined() { return !!auth.currentUser; }
  };
}

let resolveReady;
const readyP = new Promise((r) => { resolveReady = r; });
const helpers = { ready: readyP, normalizeCode: normalizeCode };
window.Backend = Object.assign({ mode: "loading" }, helpers);
(async () => {
  let b, failed = false;
  try { b = useFirebase ? await firebaseBackend() : localBackend(); }
  catch (e) { console.error("Firebase 연결 실패, 체험 모드로 전환", e); b = localBackend(); failed = true; }
  Object.assign(window.Backend, b, helpers, { failed: failed });
  resolveReady(window.Backend);
})();
})();