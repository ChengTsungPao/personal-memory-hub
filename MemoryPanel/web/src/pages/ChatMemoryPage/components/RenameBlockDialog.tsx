import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Input, Modal } from 'tea-component';

/** Names a session memory block. The name sticks: it no longer follows the session's repos. */
export function RenameBlockDialog({
  block,
  onClose,
  onRenamed,
}: {
  block: { id: string; name: string };
  onClose: () => void;
  onRenamed: (newName: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(block.name);
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const trimmed = name.trim();
  const canSubmit = !!trimmed && trimmed !== block.name && trimmed.length <= 80 && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onRenamed(trimmed);
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <Modal
      visible
      caption={t('memory.renameBlock.title')}
      size="m"
      onClose={onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        <Form layout="vertical" style={{ width: '100%' }}>
          <Form.Item label={t('memory.renameBlock.nameLabel')}>
            <Input
              size="full"
              value={name}
              onChange={setName}
              disabled={submitting}
              maxLength={80}
              placeholder={t('memory.renameBlock.namePlaceholder')}
              onPressEnter={submit}
              autoFocus
            />
          </Form.Item>
        </Form>
        <Alert type="info" style={{ marginTop: 12 }}>
          {t('memory.renameBlock.hint')}
        </Alert>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose} disabled={submitting}>
          {t('common.cancel')}
        </Button>
        <Button type="primary" onClick={submit} disabled={!canSubmit} loading={submitting}>
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
