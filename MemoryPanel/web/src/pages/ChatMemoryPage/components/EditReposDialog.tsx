import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Checkbox, Modal } from 'tea-component';

/**
 * Sets the repos a session memory block belongs to: a checklist of the repo agents. Saved as the
 * full list; none checked means no repo (the block goes to New-chat).
 */
export function EditReposDialog({
  block,
  repoAgents,
  selected,
  onClose,
  onSaved,
}: {
  block: { id: string; title: string };
  repoAgents: Array<{ agent_id: string; label: string; url?: string }>;
  /** agent ids of the repos the block belongs to now */
  selected: string[];
  onClose: () => void;
  onSaved: (repoAgentIds: string[]) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string[]>(selected);
  const [submitting, setSubmitting] = useState(false);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const changed =
    picked.length !== selected.length || picked.some((id) => !selected.includes(id));

  async function submit() {
    if (!changed || submitting) return;
    setSubmitting(true);
    try {
      await onSaved(picked);
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <Modal
      visible
      caption={t('memory.editRepos.title')}
      size={Math.min(520, window.innerWidth - 24)}
      onClose={onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        <div className="_memory-edit-repos-block" title={block.id}>
          {block.title}
        </div>
        {repoAgents.length === 0 ? (
          <Alert type="warning">{t('memory.editRepos.noRepos')}</Alert>
        ) : (
          <Checkbox.Group value={picked} onChange={setPicked} disabled={submitting}>
            <div className="_memory-edit-repos-list">
              {repoAgents.map((a) => (
                <Checkbox key={a.agent_id} name={a.agent_id}>
                  {a.label}
                  {a.url && (
                    <span className="_memory-edit-repos-url">{a.url.replace(/^https?:\/\//, '')}</span>
                  )}
                </Checkbox>
              ))}
            </div>
          </Checkbox.Group>
        )}
        <Alert type="info" style={{ marginTop: 12 }}>
          {t('memory.editRepos.hint')}
        </Alert>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose} disabled={submitting}>
          {t('common.cancel')}
        </Button>
        <Button type="primary" onClick={submit} disabled={!changed} loading={submitting}>
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
