import { useEffect, useRef, useState } from 'react';
import type { ActionView, AgentStep, ChatMessageView } from '../../shared/types';
import { ActionCard } from '../components/ActionCard';
import { Icon } from '../components/Icon';
import { Empty, Markdown, Spinner } from '../components/ui';
import { api, del, post, streamPost } from '../lib/api';
import { useApi, useApp } from '../lib/hooks';

interface ConversationItem {
  id: string;
  title: string;
  updatedAt: string;
  messages: number;
}

const SUGGESTIONS = [
  'Bu oy nima bo‘lyapti?',
  'Nega daromad tushdi?',
  'Qaysi kampaniya samarasiz va nima qilish kerak?',
  'Kim churn xavfida?',
  'Qaysi leadni birinchi ishlash kerak?',
  'Qaysi menejerning konversiyasi past?',
];

function Steps({ steps, live }: { steps: AgentStep[]; live?: boolean }) {
  if (!steps.length) return null;
  const agents = [...new Set(steps.filter((s) => s.kind === 'start').map((s) => s.agent))];
  const body = (
    <div className="steps">
      {steps.map((s, i) => (
        <div className="step" key={i}>
          <span>{s.kind === 'start' ? '▸' : s.kind === 'done' ? '✓' : '·'}</span>
          <span>
            <span className="agent">{s.agent}</span> — {s.label}
          </span>
        </div>
      ))}
    </div>
  );
  if (live) return body;
  return (
    <details className="steps-box">
      <summary>
        Agentlar ishi: {agents.length ? agents.join(', ') : 'CEO Agent'} · {steps.length} qadam
      </summary>
      {body}
    </details>
  );
}

export function ChatPage({ initialQuestion }: { initialQuestion?: string | null }) {
  const { aiEnabled, toast, navigate } = useApp();
  const list = useApi<ConversationItem[]>('/api/conversations');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);
  const [liveActions, setLiveActions] = useState<ActionView[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const asked = useRef(false);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages, liveText, liveSteps.length]);

  const open = async (id: string) => {
    setActiveId(id);
    const conv = await api<{ messages: ChatMessageView[] }>(`/api/conversations/${id}`);
    setMessages(conv.messages);
  };

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setInput('');
    setLiveText('');
    setLiveSteps([]);
    setLiveActions([]);
    let id = activeId;
    try {
      if (!id) {
        const conv = await post<{ id: string }>('/api/conversations');
        id = conv.id;
        setActiveId(id);
      }
      setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: 'user', text: q, steps: [], actions: [], createdAt: new Date().toISOString() }]);
      let final: ChatMessageView | null = null;
      await streamPost(`/api/conversations/${id}/messages`, { text: q }, (event, data) => {
        if (event === 'text') setLiveText((t) => t + data.text);
        else if (event === 'text_reset') setLiveText('');
        else if (event === 'step') setLiveSteps((s) => [...s, data.step]);
        else if (event === 'action') setLiveActions((a) => [...a, data.action]);
        else if (event === 'error') toast(`AI xatosi: ${data.error}`);
        else if (event === 'done') final = data.message;
      });
      if (final) setMessages((m) => [...m, final!]);
      await list.reload();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
      setLiveText('');
      setLiveSteps([]);
      setLiveActions([]);
    }
  };

  useEffect(() => {
    if (initialQuestion && !asked.current) {
      asked.current = true;
      navigate('suhbat');
      void send(initialQuestion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  const newChat = () => {
    setActiveId(null);
    setMessages([]);
  };

  const remove = async (id: string) => {
    await del(`/api/conversations/${id}`);
    if (id === activeId) newChat();
    await list.reload();
  };

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <div className="page-head">
        <div>
          <h1>CEO Agent bilan suhbat</h1>
          <div className="sub">
            {aiEnabled
              ? 'CEO Agent savolingizga qarab Marketing, Sales, Finance, Customer va Operations agentlarini ishga tushiradi.'
              : "AI ulanmagan: javoblar diagnostika engine'idan (ANTHROPIC_API_KEY sozlansa — to'liq multi-agent rejim)."}
          </div>
        </div>
      </div>
      <div className="chat">
        <div className="card chat-list">
          <button className="btn primary sm" onClick={newChat} style={{ marginBottom: 6 }}>
            <Icon name="plus" size={15} /> Yangi suhbat
          </button>
          {(list.data ?? []).map((c) => (
            <div key={c.id} className="row" style={{ gap: 2, flexWrap: 'nowrap' }}>
              <button className={c.id === activeId ? 'on' : ''} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => open(c.id)} title={c.title}>
                {c.title}
              </button>
              <button className="btn ghost sm" onClick={() => remove(c.id)} aria-label="O'chirish" style={{ padding: 4 }}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="card chat-panel">
          <div className="chat-messages" ref={scroller}>
            {messages.length === 0 && !busy && (
              <div className="stack" style={{ alignItems: 'center', margin: 'auto', textAlign: 'center', maxWidth: 520, gap: 14 }}>
                <div className="brand-mark" style={{ width: 44, height: 44 }}>
                  <Icon name="sparkles" size={22} />
                </div>
                <h2>Biznesingiz haqida so'rang</h2>
                <p className="small muted">Yo'ldosh AI reklama, CRM, to'lovlar va davomat ma'lumotlarini birlashtirib, sababini topadi va harakat taklif qiladi.</p>
                <div className="chips" style={{ justifyContent: 'center' }}>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="chip" onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.role === 'assistant' && <Steps steps={m.steps} />}
                <div className="msg-bubble">{m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}</div>
                {m.actions.map((a) => (
                  <ActionCard key={a.id} action={a} compact />
                ))}
              </div>
            ))}
            {busy && (
              <div className="msg assistant">
                <Steps steps={liveSteps} live />
                {liveText ? (
                  <div className="msg-bubble">
                    <Markdown text={liveText} />
                  </div>
                ) : (
                  <div className="row small muted">
                    <Spinner /> {liveSteps.length ? 'Agentlar ishlamoqda...' : 'Biznesni tekshiryapman...'}
                  </div>
                )}
                {liveActions.map((a) => (
                  <ActionCard key={a.id} action={a} compact />
                ))}
              </div>
            )}
            {messages.length === 0 && busy && null}
          </div>
          <form
            className="chat-input"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              className="textarea"
              placeholder="Masalan: “Nega bu oy IELTS sotuvlari tushdi?”"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
            />
            <button className="btn primary" type="submit" disabled={busy || !input.trim()} aria-label="Yuborish">
              <Icon name="send" size={16} />
            </button>
          </form>
        </div>
      </div>
      {list.error && <Empty>{list.error}</Empty>}
    </div>
  );
}
