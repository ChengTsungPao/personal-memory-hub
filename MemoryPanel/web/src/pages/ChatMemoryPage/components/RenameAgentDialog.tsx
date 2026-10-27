import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Input, Modal } from 'tea-component';

export function RenameAgentDialog({
  agent,
  onClose,
  onRenamed,
}: {
  agent: { agent_id: string; name: string };
  onClose: () => void;
  onRenamed: (newName: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(agent.name);
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const trimmed = name.trim();
  const canSubmit = !!trimmed && trimmed !== agent.name && !submitting;

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
      caption={t('memory.renameAgent.title', { name: agent.name })}
      size="m"
      onClose={onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        <div style={{ marginBottom: 12, color: 'var(--tea-color-text-tertiary)', fontSize: 12 }}>
          {agent.agent_id}
        </div>
        <Form layout="vertical" style={{ width: '100%' }}>
          <Form.Item label={t('memory.renameAgent.nameLabel')}>
            <Input
              size="full"
              value={name}
              onChange={setName}
              disabled={submitting}
              placeholder={t('memory.renameAgent.namePlaceholder')}
              onPressEnter={submit}
              autoFocus
            />
          </Form.Item>
        </Form>
        <Alert type="info" style={{ marginTop: 12 }}>
          {t('memory.renameAgent.hint')}
        </Alert>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose} disabled={submitting}>
          {t('common.cancel')}
        </Button>
        <Button
          type="primary"
          onClick={submit}
          disabled={!canSubmit}
          loading={submitting}
        >
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
