/** Modal dialogs on React Aria: focus trapped, Escape closes, the page behind is inert. */
import type { ReactNode } from 'react';
import {
  Dialog as AriaDialog,
  DialogTrigger,
  Heading,
  Modal,
  ModalOverlay,
  type DialogProps as AriaDialogProps,
} from 'react-aria-components';

export function Dialog({
  title,
  children,
  wide,
  isDismissable = true,
  ...props
}: Omit<AriaDialogProps, 'className' | 'children'> & {
  title: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  wide?: boolean;
  isDismissable?: boolean;
}) {
  return (
    <ModalOverlay className="cg-modal-overlay" isDismissable={isDismissable}>
      <Modal className={['cg-modal', wide ? 'cg-modal--wide' : ''].filter(Boolean).join(' ')}>
        <AriaDialog {...props} className="cg-dialog">
          {({ close }) => (
            <>
              <Heading slot="title" className="cg-dialog__title">
                {title}
              </Heading>
              {typeof children === 'function' ? children(close) : children}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

export { DialogTrigger };
