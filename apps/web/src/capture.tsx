import React from "react";
import type { Api } from "./types.js";

// Live remote-browser login (AB-ELEMENTOR D7). The browser runs in AIBroker's browser
// worker; this component shows its frames and forwards clicks, typing and scrolling.
// Nothing typed here is stored: it goes to the remote page and the capture ends once
// the site's login cookie appears (auto) or the admin presses Done (manual).

export interface CaptureFrame {
  status: "active" | "completed";
  url: string;
  title: string;
  width: number;
  height: number;
  image_base64: string;
  expires_at: number;
}

type CaptureEvent = { type: "click"; x: number; y: number } | { type: "text"; text: string } | { type: "key"; key: string } | { type: "scroll"; dy: number };

const SPECIAL_KEYS: Record<string, string> = {
  Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Escape: "Escape", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown"
};

export function RemoteBrowserCapture(props: {
  api: Api;
  captureId: string;
  initialFrame: CaptureFrame;
  mode: "auto" | "manual";
  onDone: (result: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [frame, setFrame] = React.useState<CaptureFrame>(props.initialFrame);
  const [error, setError] = React.useState("");
  const [finishing, setFinishing] = React.useState(false);
  const [now, setNow] = React.useState(Date.now());
  // The worker handles one request per capture at a time, so every call is chained.
  const queue = React.useRef<Promise<unknown>>(Promise.resolve());
  const pendingText = React.useRef("");
  const textTimer = React.useRef<number | undefined>(undefined);
  const stopped = React.useRef(false);
  const imageRef = React.useRef<HTMLImageElement>(null);
  const lastScroll = React.useRef(0);

  const enqueue = React.useCallback(<T,>(work: () => Promise<T>): Promise<T | undefined> => {
    const next = queue.current.then(async () => {
      if (stopped.current) return undefined;
      try { return await work(); }
      catch (err) {
        const status = (err as { status?: number }).status;
        setError(err instanceof Error ? err.message : "The remote browser stopped responding.");
        if (status === 404 || status === 410) stopped.current = true;
        return undefined;
      }
    });
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  const finish = React.useCallback(async () => {
    if (stopped.current) return;
    setFinishing(true);
    const result = await enqueue(() => props.api<Record<string, unknown>>(`/me/login-captures/${props.captureId}/finish`, { method: "POST" }));
    setFinishing(false);
    if (result && result.status === "completed") { stopped.current = true; props.onDone(result); }
  }, [enqueue, props]);

  const send = React.useCallback((events: CaptureEvent[]) => {
    void enqueue(async () => {
      const body = await props.api<{ frame: CaptureFrame }>(`/me/login-captures/${props.captureId}/input`, { method: "POST", body: JSON.stringify({ events }) });
      setFrame(body.frame);
      return body;
    });
  }, [enqueue, props]);

  const flushText = React.useCallback(() => {
    if (!pendingText.current) return;
    const text = pendingText.current;
    pendingText.current = "";
    send([{ type: "text", text }]);
  }, [send]);

  // Poll frames; finish automatically once the site's login cookie shows up.
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void enqueue(async () => {
        const body = await props.api<{ frame: CaptureFrame }>(`/me/login-captures/${props.captureId}/frame`, { method: "POST" });
        setFrame(body.frame);
        return body;
      });
    }, 1200);
    return () => window.clearInterval(timer);
  }, [enqueue, props]);
  React.useEffect(() => {
    if (props.mode === "auto" && frame.status === "completed" && !finishing) void finish();
  }, [frame.status, props.mode, finish, finishing]);
  React.useEffect(() => () => { stopped.current = true; window.clearTimeout(textTimer.current); }, []);

  const click = (event: React.MouseEvent<HTMLImageElement>) => {
    flushText();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.round((event.clientX - rect.left) * (frame.width / rect.width));
    const y = Math.round((event.clientY - rect.top) * (frame.height / rect.height));
    send([{ type: "click", x, y }]);
  };

  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const special = SPECIAL_KEYS[event.key];
    if (special) {
      event.preventDefault();
      flushText();
      send([{ type: "key", key: special }]);
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      pendingText.current += event.key;
      window.clearTimeout(textTimer.current);
      textTimer.current = window.setTimeout(flushText, 150);
    }
  };

  const cancel = async () => {
    stopped.current = true;
    await props.api(`/me/login-captures/${props.captureId}`, { method: "DELETE" }).catch(() => undefined);
    props.onCancel();
  };

  const secondsLeft = Math.max(0, Math.round((frame.expires_at - now) / 1000));
  return <div className="panel">
    <p className="muted">Log in on the page below: click to focus a field, then type. {props.mode === "auto"
      ? "AIBroker finishes automatically once you're logged in."
      : "Press Done once you're logged in."} Time left: {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</p>
    <div className="muted"><code>{frame.url}</code></div>
    {error ? <div className="inline-notice inline-notice-error"><span>{error}</span></div> : null}
    <div tabIndex={0} onKeyDown={keyDown} onPaste={(event) => { const text = event.clipboardData.getData("text"); if (text) { event.preventDefault(); flushText(); send([{ type: "text", text: text.slice(0, 1000) }]); } }}
      onWheel={(event) => { if (Date.now() - lastScroll.current < 300) return; lastScroll.current = Date.now(); send([{ type: "scroll", dy: Math.round(event.deltaY * 3) }]); }}
      style={{ outline: "1px solid var(--border, #ccc)", maxWidth: "100%", cursor: "pointer" }} aria-label="Remote login browser">
      <img ref={imageRef} alt={frame.title || "Remote browser"} src={`data:image/jpeg;base64,${frame.image_base64}`} onClick={click}
        style={{ display: "block", width: "100%", height: "auto", userSelect: "none" }} draggable={false} />
    </div>
    <div className="cell-actions">
      {props.mode === "manual" ? <button className="button-primary" disabled={finishing} onClick={() => void finish()}>Done</button> : null}
      <button onClick={() => void cancel()}>Cancel</button>
    </div>
  </div>;
}
