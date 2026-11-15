import React from 'react';
import { createPortal } from 'react-dom';
import { createModalStack, trapTabTarget } from './modalLogic';

/**
 * The one modal dialog. It owns the behaviour every modal needs and none of the look:
 *
 * - `role="dialog"`, `aria-modal`, and `aria-labelledby` pointing at its `ModalTitle`;
 * - Escape closes it, unless something inside already handled the key (an input that
 *   uses Escape to cancel its own mode calls `preventDefault()`, and that wins);
 * - focus moves in on open (`initialFocusRef`, else the first tabbable element, else
 *   the dialog itself), Tab and Shift+Tab wrap inside it, and focus goes back to
 *   whatever had it before the dialog opened;
 * - a mousedown on the backdrop closes it, as every modal here has always done.
 *
 * Only the topmost open modal answers the keyboard, so a confirm raised over another
 * modal closes alone. The page behind keeps scrolling: nothing here locks the body.
 *
 * It renders into `document.body` through a portal. A `position: fixed` backdrop
 * inside a transformed or filtered ancestor is fixed to that ancestor instead of the
 * viewport: the Discord help modal's scrim used to stop at the edges of its settings
 * card, leaving the rail, nav and stat bar live and undimmed beside it.
 *
 * Callers keep their own classes. `as="form"` makes the dialog element the form
 * itself, so `.stream-info-modal` and friends lay out exactly as before.
 */

const modalStack = createModalStack();
let nextModalId = 1;

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'summary',
  '[tabindex]',
  '[contenteditable="true"]',
].join(',');

function tabbableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => {
    if (el.tabIndex < 0) return false;
    if ('disabled' in el && (el as HTMLButtonElement).disabled) return false;
    if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
    if (el.closest('[inert]')) return false;
    // display:none (itself or an ancestor) leaves no boxes.
    return el.getClientRects().length > 0;
  });
}

const ModalTitleContext = React.createContext<string | null>(null);

/** The dialog's heading. Rendering it is what gives the dialog its accessible name. */
export function ModalTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  const id = React.useContext(ModalTitleContext);
  return <h2 id={id ?? undefined} className={className}>{children}</h2>;
}

export type ModalProps = {
  onClose: () => void;
  /** Classes for the dialog element (the panel), not the backdrop. */
  className?: string;
  /** `form` makes the dialog element the form, so submit and layout are unchanged. */
  as?: 'div' | 'form';
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
  /** A mousedown on the backdrop closes the dialog. Every modal here does; defaults on. */
  closeOnBackdrop?: boolean;
  /** Where focus lands on open. Falls back to the first tabbable element. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Id of an element that describes the dialog (a confirm's body text). */
  describedBy?: string;
  children: React.ReactNode;
};

export function Modal({
  onClose,
  className,
  as = 'div',
  onSubmit,
  closeOnBackdrop = true,
  initialFocusRef,
  describedBy,
  children,
}: ModalProps) {
  const titleId = React.useId();
  const dialogRef = React.useRef<HTMLElement | null>(null);
  const [modalId] = React.useState(() => nextModalId++);
  // Read during the first render, before any child's autoFocus moves focus inward.
  const [returnFocusTo] = React.useState(() =>
    typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null,
  );

  const onCloseRef = React.useRef(onClose);
  React.useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  const initialFocusRefRef = React.useRef(initialFocusRef);

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    modalStack.push(modalId);

    // A child with autoFocus has already taken focus by now; leave it there.
    if (!dialog.contains(document.activeElement)) {
      initialFocusRefRef.current?.current?.focus();
      if (!dialog.contains(document.activeElement)) {
        (tabbableIn(dialog)[0] ?? dialog).focus();
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!modalStack.isTop(modalId)) return;
      if (event.key === 'Escape') {
        if (event.defaultPrevented || event.isComposing) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = tabbableIn(dialog);
      const active = document.activeElement as HTMLElement | null;
      const target = trapTabTarget(items.length, active ? items.indexOf(active) : -1, event.shiftKey);
      if (target === null) return;
      event.preventDefault();
      (items[target] ?? dialog).focus();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      modalStack.remove(modalId);
      if (returnFocusTo && returnFocusTo.isConnected && typeof returnFocusTo.focus === 'function') {
        returnFocusTo.focus();
      }
    };
  }, [modalId, returnFocusTo]);

  const dialogProps = {
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': titleId,
    'aria-describedby': describedBy,
    className,
    tabIndex: -1,
  } as const;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={event => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <ModalTitleContext.Provider value={titleId}>
        {as === 'form' ? (
          <form {...dialogProps} ref={dialogRef as React.Ref<HTMLFormElement>} onSubmit={onSubmit}>
            {children}
          </form>
        ) : (
          <div {...dialogProps} ref={dialogRef as React.Ref<HTMLDivElement>}>
            {children}
          </div>
        )}
      </ModalTitleContext.Provider>
    </div>,
    document.body,
  );
}
