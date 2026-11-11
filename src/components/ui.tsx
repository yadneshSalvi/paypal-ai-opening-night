"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { ArrowUpRight, LoaderCircle, X } from "lucide-react";
export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "amber" | "green" | "red" | "blue" }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Button({ children, onClick, disabled, busy, variant = "secondary", className = "", title, ariaLabel }: { children: ReactNode; onClick?: () => void; disabled?: boolean; busy?: boolean; variant?: "primary" | "secondary" | "ghost"; className?: string; title?: string; ariaLabel?: string }) {
  return <button type="button" className={`button ${variant} ${className}`} onClick={onClick} disabled={disabled || busy} aria-busy={busy} aria-label={ariaLabel} title={title}>{busy ? <LoaderCircle size={15} className="spin" /> : null}{children}</button>;
}
export function SectionHeading({ label, title, aside }: { label?: string; title: string; aside?: ReactNode }) { return <div className="section-heading"><div>{label && <span className="eyebrow">{label}</span>}<h2>{title}</h2></div>{aside}</div>; }
export function PageHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) { return <header className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="heading-actions">{actions}</div></header>; }
export function EmptyState({ title, children, icon, action }: { title: string; children: ReactNode; icon?: ReactNode; action?: ReactNode }) { return <div className="empty-state"><div className="empty-icon">{icon ?? <ArrowUpRight size={22} />}</div><h3>{title}</h3><p>{children}</p>{action}</div>; }
export function Modal({ title, children, onClose, dismissible = true, fallbackFocus }: { title: string; children: ReactNode; onClose: () => void; dismissible?: boolean; fallbackFocus?: () => HTMLElement | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const focusFallback = useRef(fallbackFocus); focusFallback.current = fallbackFocus;
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current!; const prior = document.activeElement; node.showModal();
    const restore = (target: Element | null | undefined) => {
      if (!(target instanceof HTMLElement) || !target.isConnected || target.closest("[inert]") || !target.getClientRects().length || getComputedStyle(target).visibility !== "visible") return false;
      target.focus({ preventScroll: true }); return document.activeElement === target;
    };
    return () => { node.close(); if (!restore(prior)) restore(focusFallback.current?.()); };
  }, []);
  return <dialog ref={dialog} className="modal" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (dismissible) onClose(); }} onClick={e => { if (dismissible && e.target === e.currentTarget) onClose(); }}><div className="modal-inner"><div className="modal-heading"><h2 id={titleId}>{title}</h2>{dismissible && <button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button>}</div>{children}</div></dialog>;
}
export const formatCount = (number: number) => number.toString().padStart(2, "0");
