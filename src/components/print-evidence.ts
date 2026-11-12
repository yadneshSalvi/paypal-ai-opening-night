"use client";
import { useEffect, type RefObject } from "react";

/** Print the retained evidence, then restore this view's exact disclosure state. */
export function usePrintEvidence(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let disclosures: { element: HTMLDetailsElement; open: boolean }[] | null = null;
    const restore = () => {
      if (!disclosures) return;
      for (const { element, open } of disclosures) element.open = open;
      disclosures = null;
    };
    const prepare = () => {
      if (disclosures || !root.current) return;
      disclosures = [...root.current.querySelectorAll("details")].map(element => ({ element, open: element.open }));
      for (const { element } of disclosures) element.open = true;
    };
    window.addEventListener("beforeprint", prepare);
    window.addEventListener("afterprint", restore);
    return () => { window.removeEventListener("beforeprint", prepare); window.removeEventListener("afterprint", restore); restore(); };
  }, [root]);
}
