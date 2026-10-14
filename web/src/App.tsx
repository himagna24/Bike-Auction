import { useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { api, setToken, getToken, API_URL, money } from './api';

type User = { id: string; email: string; role: 'BUYER' | 'ADMIN' };
type Bid = { id: string; amountCents: number; createdAt: string; userId: string; bidder: string };
type Auction = {
  id: string; title: string; make: string; model: string; year: number; km: number; imageUrl: string | null;
  description: string | null; status: string; startPriceCents: number; currentPriceCents: number;
  minIncrementCents: number; bidCount: number; startsAt: string; endsAt: string; winnerId: string | null;
  reserveMet: boolean; serverTime: string; bids?: Bid[];
};

function useHash() {
  const [h, setH] = useState(location.hash || '#/');
  useEffect(() => {
    const f = () => setH(location.hash || '#/');
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return h;
}

/** Countdown driven by the SERVER clock: offset = serverTime - localTime, measured when data was fetched. */
function useRemaining(target: string, serverTime: string) {
  const offset = useMemo(() => Date.parse(serverTime) - Date.now(), [serverTime]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);
  return Date.parse(target) - (now + offset);
}
function fmt(ms: number) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60, p = (n: number) => String(n).padStart(2, '0');
  return d > 0 ? `${d}d ${h}h ${m}m` : `${p(h)}:${p(m)}:${p(sec)}`;
}

function Timer({ a }: { a: Auction }) {
  const target = a.status === 'SCHEDULED' ? a.startsAt : a.endsAt;
  const ms = useRemaining(target, a.serverTime);
  if (a.status !== 'LIVE' && a.status !== 'SCHEDULED') return <span className="meta">Ended</span>;
  return <span className={'timer' + (a.status === 'LIVE' && ms < 60000 ? ' hot' : '')}>
    {a.status === 'SCHEDULED' ? 'Starts in ' : ''}{fmt(ms)}</span>;
}

function Pic({ a, h }: { a: Auction; h?: number }) {
  return <div className="pic" style={{ height: h, backgroundImage: a.imageUrl ? `url(${a.imageUrl})` : undefined }}>
    {!a.imageUrl && a.make.slice(0, 2).toUpperCase()}</div>;
}

function Home() {
  const [items, setItems] = useState<Auction[] | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('LIVE');
  useEffect(() => {
    const load = () => api<{ items: Auction[] }>('/api/auctions?limit=100').then(r => { setItems(r.items); setErr(''); }).catch(e => setErr(e.message));
    load(); const t = setInterval(load, 10000); return () => clearInterval(t);
  }, []);
  const tabs: [string, string[]][] = [['LIVE', ['LIVE']], ['Upcoming', ['SCHEDULED']], ['Ended', ['SOLD', 'UNSOLD', 'CANCELLED']]];
  const shown = items?.filter(a => (tabs.find(t => t[0] === tab)![1]).includes(a.status)) ?? [];
  return <>
    <h1>Motorcycle auctions</h1><p className="sub">Bid live. Prices update instantly for everyone watching.</p>
    <div className="tabs">{tabs.map(([n]) => <button key={n} className={'tab' + (tab === n ? ' on' : '')} onClick={() => setTab(n)}>{n}</button>)}</div>
    {err && <div className="msg err">{err}</div>}
    {!items && !err && <div className="empty">Loading auctions…</div>}
    {items && shown.length === 0 && <div className="empty">No auctions here right now.</div>}
    <div className="grid">{shown.map(a => <a key={a.id} className="card" href={`#/auction/${a.id}`}>
      <Pic a={a} /><div className="body">
        <div className="row"><h3>{a.title}</h3><span className={'badge ' + a.status}>{a.status}</span></div>
        <div className="meta">{a.year} · {a.km.toLocaleString('en-IN')} km</div>
        <div className="price">{money(a.currentPriceCents)}</div>
        <div className="row meta"><span>{a.bidCount} bid{a.bidCount === 1 ? '' : 's'}</span><Timer a={a} /></div>
      </div></a>)}</div>
  </>;
}

function AuctionPage({ id, user }: { id: string; user: User | null }) {
  const [a, setA] = useState<Auction | null>(null);
  const [err, setErr] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [live, setLive] = useState(false);

  const load = useCallback(() => api<Auction>(`/api/auctions/${id}`).then(setA).catch(e => setErr(e.message)), [id]);
  useEffect(() => {
    load();
    const s = io(API_URL || undefined, { auth: { token: getToken() } });
    s.on('connect', () => { setLive(true); s.emit('join', id); load(); }); // reload on reconnect to catch missed events
    s.on('disconnect', () => setLive(false));
    s.on('bid', load); s.on('auction:status', load);
    return () => { s.disconnect(); };
  }, [id, load]);

  if (err) return <div className="msg err">{err}</div>;
  if (!a) return <div className="empty">Loading…</div>;
  const minCents = a.bidCount === 0 ? a.currentPriceCents : a.currentPriceCents + a.minIncrementCents;
  const isLive = a.status === 'LIVE';

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const cents = Math.round(Number(amount) * 100);
    if (!(cents > 0)) return setMsg({ ok: false, t: 'Enter a valid amount' });
    setBusy(true);
    try {
      // A fresh idempotency key per submit: a network retry of THIS request can never double-bid.
      await api(`/api/auctions/${id}/bids`, { method: 'POST', body: { amountCents: cents }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
      setMsg({ ok: true, t: 'Bid placed!' }); setAmount('');
    } catch (er: any) { setMsg({ ok: false, t: er.message }); }
    finally { setBusy(false); load(); }
  }

  const top = a.bids?.[0];
  return <>
    <p><a href="#/" className="meta">← All auctions</a></p>
    <div className="detail">
      <div>
        <Pic a={a} h={300} />
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="row"><h1 style={{ fontSize: 22 }}>{a.title}</h1><span className={'badge ' + a.status}>{a.status}</span></div>
          <p className="meta">{a.make} {a.model} · {a.year} · {a.km.toLocaleString('en-IN')} km</p>
          <p>{a.description}</p>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
        <div className="panel">
          <div className="meta">{a.bidCount === 0 ? 'Starting price' : 'Current bid'}</div>
          <div className="big">{money(a.currentPriceCents)}</div>
          <div className="row" style={{ margin: '8px 0' }}>
            <span className="bigtimer"><Timer a={a} /></span>
            <span className="meta">{isLive ? (live ? '● Live' : '○ Reconnecting…') : ''}</span>
          </div>
          <div className="meta">{a.reserveMet ? 'Reserve met' : 'Reserve not met'} · min increment {money(a.minIncrementCents)}</div>
          {isLive && <div className="meta">Bids in the last 30s extend the auction by 30s.</div>}
          {a.status === 'SOLD' && <div className="msg ok" style={{ marginTop: 12 }}>
            {user && a.winnerId === user.id ? '🎉 You won this auction!' : `Sold for ${money(a.currentPriceCents)}`}</div>}
          {a.status === 'UNSOLD' && <div className="msg err" style={{ marginTop: 12 }}>Ended without meeting the reserve.</div>}
          {isLive && (user ? <form className="stack" onSubmit={submit} style={{ marginTop: 14 }}>
            <label>Your bid (₹) — minimum {money(minCents)}
              <input type="number" inputMode="numeric" min={minCents / 100} step="1" value={amount}
                onChange={e => setAmount(e.target.value)} placeholder={String(minCents / 100)} /></label>
            <div className="two">
              <button type="button" className="ghost" onClick={() => setAmount(String(minCents / 100))}>Minimum bid</button>
              <button className="btn" disabled={busy}>{busy ? 'Placing…' : 'Place bid'}</button>
            </div>
            {msg && <div className={'msg ' + (msg.ok ? 'ok' : 'err')}>{msg.t}</div>}
          </form> : <p style={{ marginTop: 14 }}><a href="#/login" className="btn" style={{ padding: '10px 16px', borderRadius: 9, background: 'var(--brand)', color: '#fff', display: 'inline-block' }}>Log in to bid</a></p>)}
        </div>
        <div className="panel">
          <b>Bid history</b>
          {a.bids?.length ? <ul className="bids">{a.bids.map(b => <li key={b.id}>
            <span>{b.bidder}{user && b.userId === user.id ? ' (you)' : ''}{top?.id === b.id && isLive ? ' · leading' : ''}</span>
            <span>{money(b.amountCents)}</span></li>)}</ul> : <p className="meta">No bids yet. Be the first!</p>}
        </div>
      </div>
    </div>
  </>;
}

function Login({ onUser }: { onUser: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function go(e: React.FormEvent, creds = { email, password }) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = await api<{ token: string; user: User }>(`/api/auth/${mode}`, { method: 'POST', body: creds });
      setToken(r.token); onUser(r.user); location.hash = r.user.role === 'ADMIN' ? '#/admin' : '#/';
    } catch (er: any) { setErr(er.message); } finally { setBusy(false); }
  }
  return <div className="panel auth">
    <h1 style={{ fontSize: 22 }}>{mode === 'login' ? 'Welcome back' : 'Create account'}</h1>
    <form className="stack" onSubmit={go}>
      <label>Email<input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>
      <label>Password{mode === 'register' && ' (min 8 characters)'}<input type="password" required minLength={8} value={password}
        onChange={e => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
      {err && <div className="msg err">{err}</div>}
      <button className="btn" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Sign up'}</button>
    </form>
    <p className="meta" style={{ marginTop: 12 }}>
      <a href="#/login" onClick={() => setMode(mode === 'login' ? 'register' : 'login')} style={{ textDecoration: 'underline' }}>
        {mode === 'login' ? 'New here? Create an account' : 'Have an account? Log in'}</a></p>
    {mode === 'login' && <div className="demo">
      <button className="ghost" type="button" onClick={e => go(e as any, { email: 'buyer1@bikes.test', password: 'Buyer123!' })}>Demo buyer</button>
      <button className="ghost" type="button" onClick={e => go(e as any, { email: 'admin@bikes.test', password: 'Admin123!' })}>Demo admin</button>
    </div>}
  </div>;
}

const blank = { title: '', make: '', model: '', year: '2020', km: '', imageUrl: '', description: '', start: '', reserve: '', inc: '500', startsAt: '', endsAt: '' };
function Admin({ user }: { user: User | null }) {
  const [list, setList] = useState<Auction[]>([]);
  const [f, setF] = useState(blank);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const load = useCallback(() => api<{ items: Auction[] }>('/api/auctions?limit=100').then(r => setList(r.items)), []);
  useEffect(() => { load(); }, [load]);
  if (user?.role !== 'ADMIN') return <div className="msg err">Admin access only. <a href="#/login" style={{ textDecoration: 'underline' }}>Log in as admin</a></div>;
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function create(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    try {
      await api('/api/auctions', { method: 'POST', body: {
        title: f.title, make: f.make, model: f.model, year: Number(f.year), km: Number(f.km),
        ...(f.imageUrl && { imageUrl: f.imageUrl }), ...(f.description && { description: f.description }),
        startPriceCents: Math.round(Number(f.start) * 100), ...(f.reserve && { reservePriceCents: Math.round(Number(f.reserve) * 100) }),
        minIncrementCents: Math.round(Number(f.inc) * 100),
        startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString() } });
      setMsg({ ok: true, t: 'Auction created' }); setF(blank); load();
    } catch (er: any) { setMsg({ ok: false, t: er.message }); }
  }
  async function cancel(a: Auction) {
    if (!confirm(`Cancel "${a.title}"? This cannot be undone.`)) return;
    try { await api(`/api/auctions/${a.id}/cancel`, { method: 'POST' }); load(); } catch (er: any) { alert(er.message); }
  }
  return <>
    <h1>Admin</h1><p className="sub">Create and manage auctions.</p>
    <div className="panel"><b>New auction</b>
      <form className="stack" onSubmit={create} style={{ marginTop: 10 }}>
        <label>Title<input required value={f.title} onChange={set('title')} /></label>
        <div className="two"><label>Make<input required value={f.make} onChange={set('make')} /></label><label>Model<input required value={f.model} onChange={set('model')} /></label></div>
        <div className="two"><label>Year<input required type="number" value={f.year} onChange={set('year')} /></label><label>Odometer (km)<input required type="number" value={f.km} onChange={set('km')} /></label></div>
        <label>Image URL (optional)<input type="url" value={f.imageUrl} onChange={set('imageUrl')} /></label>
        <label>Description<input value={f.description} onChange={set('description')} /></label>
        <div className="two"><label>Start price (₹)<input required type="number" min="1" value={f.start} onChange={set('start')} /></label><label>Reserve (₹, optional)<input type="number" value={f.reserve} onChange={set('reserve')} /></label></div>
        <label>Min increment (₹)<input required type="number" min="1" value={f.inc} onChange={set('inc')} /></label>
        <div className="two"><label>Starts<input required type="datetime-local" value={f.startsAt} onChange={set('startsAt')} /></label><label>Ends<input required type="datetime-local" value={f.endsAt} onChange={set('endsAt')} /></label></div>
        {msg && <div className={'msg ' + (msg.ok ? 'ok' : 'err')}>{msg.t}</div>}
        <button className="btn">Create auction</button>
      </form></div>
    <div className="panel" style={{ marginTop: 16, overflowX: 'auto' }}><b>All auctions</b>
      <table><thead><tr><th>Title</th><th>Status</th><th>Price</th><th>Bids</th><th></th></tr></thead><tbody>
        {list.map(a => <tr key={a.id}><td><a href={`#/auction/${a.id}`}>{a.title}</a></td>
          <td><span className={'badge ' + a.status}>{a.status}</span></td><td>{money(a.currentPriceCents)}</td><td>{a.bidCount}</td>
          <td>{(a.status === 'LIVE' || a.status === 'SCHEDULED') && <button className="ghost" onClick={() => cancel(a)}>Cancel</button>}</td></tr>)}
      </tbody></table></div>
  </>;
}

export default function App() {
  const hash = useHash();
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => { if (getToken()) api<User>('/api/me').then(setUser).catch(() => setToken(null)); }, []);
  const logout = () => { setToken(null); setUser(null); location.hash = '#/'; };
  const m = hash.match(/^#\/auction\/([\w-]+)/);
  return <>
    <header><a href="#/" className="logo">🏍 BikeBid</a>
      <nav><a href="#/">Auctions</a>{user?.role === 'ADMIN' && <a href="#/admin">Admin</a>}</nav>
      {user ? <><span className="meta">{user.email}</span><button className="ghost" onClick={logout}>Log out</button></>
        : <a href="#/login" className="ghost" style={{ padding: '6px 11px', border: '1px solid var(--line)', borderRadius: 8 }}>Log in</a>}
    </header>
    <main>
      {m ? <AuctionPage id={m[1]} user={user} /> : hash === '#/login' ? <Login onUser={setUser} /> :
        hash === '#/admin' ? <Admin user={user} /> : <Home />}
    </main>
  </>;
}
