/*
  학급방 데이터 연결 (Firebase 또는 체험 모드)
  - Firebase 연결 정보가 있으면 Firestore + 익명 로그인(학생) + 구글 로그인(교사)을 씁니다.
  - 없으면 체험 모드: 이 브라우저의 저장소에 방과 기록을 저장합니다. 같은 기기의 여러 탭끼리만 공유됩니다.
  화면 코드는 window.Backend 만 사용합니다.
*/
(function () {
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FB_VER = "10.12.2";
function makeCode() { let s = ""; for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }
function normalizeCode(c) { return String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); }
const cfg = window.FIREBASE_CONFIG || {};
const useFirebase = !!(cfg.apiKey && cfg.projectId);

/* ---------------- 체험 모드 ---------------- */
function localBackend() {
  const KEY = "oweol-room-demo-db", ME = "oweol-room-demo-me";
  const bus = new Set();
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { rooms: {} }; } catch (e) { return { rooms: {} }; } };
  const write = (db) => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} bus.forEach((f) => f()); };
  window.addEventListener("storage", (e) => { if (e.key === KEY) bus.forEach((f) => f()); });
  const teacher = { uid: "demo-teacher", name: "체험용 교사" };
  let me = null; try { me = JSON.parse(sessionStorage.getItem(ME)); } catch (e) {}
  const strip = (r) => { const x = Object.assign({}, r); delete x.students; return x; };
  return {
    mode: "local",
    onTeacher(cb) { let on = false; try { on = !!localStorage.getItem("oweol-demo-teacher"); } catch (e) {} cb(on ? teacher : null); return () => {}; },
    async signInTeacher() { try { localStorage.setItem("oweol-demo-teacher", "1"); } catch (e) {} return teacher; },
    async signOutTeacher() { try { localStorage.removeItem("oweol-demo-teacher"); } catch (e) {} },
    async createRoom(title) {
      const db = read(); let code; do { code = makeCode(); } while (db.rooms[code]);
      db.rooms[code] = { code: code, title: title, ownerUid: teacher.uid, open: true, createdAt: Date.now(), students: {} };
      write(db); return code;
    },
    watchMyRooms(cb) {
      const f = () => cb(Object.values(read().rooms).filter((r) => r.ownerUid === teacher.uid).map(strip).sort((a, b) => b.createdAt - a.createdAt));
      bus.add(f); f(); return () => bus.delete(f);
    },
    watchRoom(code, cb) { const f = () => { const r = read().rooms[code]; cb(r ? strip(r) : null); }; bus.add(f); f(); return () => bus.delete(f); },
    watchStudents(code, cb) {
      const f = () => { const r = read().rooms[code]; cb(r ? Object.keys(r.students).map((id) => Object.assign({ id: id }, r.students[id])) : []); };
      bus.add(f); f(); const t = setInterval(f, 3000); return () => { bus.delete(f); clearInterval(t); };
    },
    async setRoomOpen(code, open) { const db = read(); if (db.rooms[code]) { db.rooms[code].open = open; write(db); } },
    async deleteStudent(code, id) { const db = read(); if (db.rooms[code]) { delete db.rooms[code].students[id]; write(db); } },
    async deleteRoom(code) { const db = read(); delete db.rooms[code]; write(db); },
    async joinRoom(code, number, nickname) {
      code = normalizeCode(code); const db = read(), r = db.rooms[code];
      if (!r) return { ok: false, error: "no_room" };
      if (!r.open) return { ok: false, error: "closed" };
      const id = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
  const roomRef = (code) => F.doc(db, "rooms", code);
  const stuCol = (code) => F.collection(db, "rooms", code, "students");
  const isTeacher = (u) => !!(u && !u.isAnonymous);
  const ms = (t) => (t && t.toMillis ? t.toMillis() : t || 0);
  const errCode = (e) => (e && (e.code === "auth/admin-restricted-operation" || e.code === "auth/operation-not-allowed") ? "auth_off" : e && e.code === "permission-denied" ? "closed" : e && (e.code === "unavailable" || e.code === "auth/network-request-failed") ? "offline" : "error");
  return {
    mode: "firebase",
    onTeacher(cb) { return A.onAuthStateChanged(auth, (u) => cb(isTeacher(u) ? { uid: u.uid, name: u.displayName || u.email || "교사" } : null)); },
    async signInTeacher() { const r = await A.signInWithPopup(auth, new A.GoogleAuthProvider()); return { uid: r.user.uid, name: r.user.displayName }; },
    async signOutTeacher() { await A.signOut(auth); },
    async createRoom(title) {
      for (let i = 0; i < 6; i++) {
        const code = makeCode(), ref = roomRef(code);
        const snap = await F.getDoc(ref).catch(() => null);
        if (snap && snap.exists()) continue;
        await F.setDoc(ref, { code: code, title: title, ownerUid: auth.currentUser.uid, open: true, createdAt: F.serverTimestamp() });
        return code;
      }
      throw new Error("code");
    },
    watchMyRooms(cb) {
      const q = F.query(F.collection(db, "rooms"), F.where("ownerUid", "==", auth.currentUser.uid));
      return F.onSnapshot(q, (s) => cb(s.docs.map((d) => Object.assign({}, d.data(), { createdAt: ms(d.data().createdAt) })).sort((a, b) => b.createdAt - a.createdAt)), () => cb([]));
    },
    watchRoom(code, cb) { return F.onSnapshot(roomRef(code), (d) => cb(d.exists() ? Object.assign({}, d.data(), { createdAt: ms(d.data().createdAt) }) : null), () => cb(null)); },
    watchStudents(code, cb) {
      return F.onSnapshot(stuCol(code), (s) => cb(s.docs.map((d) => { const x = d.data(); return Object.assign({ id: d.id }, x, { joinedAt: ms(x.joinedAt), updatedAt: ms(x.updatedAt) }); })), () => cb([]));
    },
    async setRoomOpen(code, open) { await F.updateDoc(roomRef(code), { open: open }); },
    async deleteStudent(code, id) { await F.deleteDoc(F.doc(db, "rooms", code, "students", id)); },
    async deleteRoom(code) {
      const s = await F.getDocs(stuCol(code));
      for (let i = 0; i < s.docs.length; i += 400) { const b = F.writeBatch(db); s.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref)); await b.commit(); }
      await F.deleteDoc(roomRef(code));
    },
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
      if (!auth.currentUser || !auth.currentUser.isAnonymous) return { ok: false, error: "not_joined" };
      try { await F.setDoc(F.doc(db, "rooms", code, "students", auth.currentUser.uid), Object.assign({}, data, { updatedAt: F.serverTimestamp() }), { merge: true }); return { ok: true }; }
      catch (e) { console.error(e); return { ok: false, error: errCode(e) }; }
    },
    async leave() { if (auth.currentUser && auth.currentUser.isAnonymous) await A.signOut(auth); },
    async isJoined() { return !!(auth.currentUser && auth.currentUser.isAnonymous); }
  };
}

let resolveReady;
const readyP = new Promise((r) => { resolveReady = r; });
window.Backend = { ready: readyP, normalizeCode: normalizeCode, mode: "loading" };
(async () => {
  let b, failed = false;
  try { b = useFirebase ? await firebaseBackend() : localBackend(); }
  catch (e) { console.error("Firebase 연결 실패, 체험 모드로 전환", e); b = localBackend(); failed = true; }
  Object.assign(window.Backend, b, { ready: readyP, normalizeCode: normalizeCode, failed: failed });
  resolveReady(window.Backend);
})();})();
