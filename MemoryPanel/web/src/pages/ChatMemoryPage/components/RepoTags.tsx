import { useTranslation } from 'react-i18next';

/**
 * The repos a session memory block belongs to, as tags (name + short root commit hash, linked to
 * the repo when it has a web link). A block with no repo is a New-chat one.
 */
export function RepoTags({
  repos,
}: {
  repos?: Array<{ name: string; hash: string; url?: string }>;
}) {
  const { t } = useTranslation();
  if (!repos) return null;
  if (repos.length === 0) {
    return (
      <div className="_memory-repo-tags">
        <span className="_memory-repo-tag _memory-repo-tag--none">{t('memory.repoTags.none')}</span>
      </div>
    );
  }
  return (
    <div className="_memory-repo-tags">
      {repos.map((r) => {
        const label = (
          <>
            {r.name}
            <span className="_memory-repo-tag-hash">{r.hash.slice(0, 7)}</span>
          </>
        );
        return r.url && /^https?:\/\//.test(r.url) ? (
          <a
            key={r.hash}
            className="_memory-repo-tag"
            href={r.url}
            target="_blank"
            rel="noreferrer"
            title={r.url}
            onClick={(e) => e.stopPropagation()}
          >
            {label}
          </a>
        ) : (
          <span key={r.hash} className="_memory-repo-tag" title={r.hash}>
            {label}
          </span>
        );
      })}
    </div>
  );
}
