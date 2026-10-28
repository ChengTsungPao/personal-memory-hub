/**
 * ChatMemoryPanel — 原子能力 · 记忆。
 *
 * 本文件只保留渲染与组装；状态/数据逻辑在 useChatMemory，常量与工具在 memory-utils。
 */
import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Segment, Select } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import { agentsApi, chatMemoryApi } from '@/lib/teamApi';
import { invalidateBackendCache } from '@/services';
import { type ScopeTab } from '../constants/types';

import { BlockDetail } from './BlockDetail';
import { ImportBlockDialog } from './ImportBlockDialog';
import { AllocateMemoryDialog } from './AllocateMemoryDialog';
import { RenameAgentDialog } from './RenameAgentDialog';
import { RenameBlockDialog } from './RenameBlockDialog';
import { RepoTags } from './RepoTags';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import { AssetSplitLayout } from '@/components/asset/AssetSplitLayout';
import {
  AssetListPanel,
  AssetItemBadges,
  AssetItemTime,
} from '@/components/asset/AssetListPanel';
import { UserBadge } from '@/components/asset/UserBadge';
import { useChatMemory } from '../hooks/useChatMemory';
import '../styles/chat-memory-panel.css';
import { repoAgentLabel, repoUrl } from '@/lib/memory-agents';


export default function ChatMemoryPanel(
  props: {
    currentUser?: string;
    activeTeamId?: string | null;
  } = {},
) {
  const { t } = useTranslation();
  const store = useChatMemory(props);

  const [showRename, setShowRename] = useState(false);
  const [renamingBlock, setRenamingBlock] = useState<{ id: string; name: string } | null>(null);

  const {
    // context
    activeTeam,
    activeTeamId,
    currentUserId,
    ownedTeamAgents,
    scopeTabLabels,
    // state
    blocks,
    blocksLoading,
    selectedId,
    setSelectedId,
    layer,
    setLayer,
    layerLoading,
    layerItemLoadingId,
    l0MoreLoading,
    timeRange,
    setTimeRange,
    rangeTooLarge,
    showImport,
    setShowImport,
    showAllocate,
    setShowAllocate,
    scopeTab,
    setScopeTab,
    agentFilter,
    setAgentFilter,
    // computed
    selected,
    layerPage,
    pageSize,
    windowTotal,
    filtered,
    // handlers
    fetchBlocks,
    handleLayerPageChange,
    handleL0LoadMore,
    handleLayerItemLoad,
    handleSaveLayerItem,
    searchLayer,
    refreshLayer,
    handleDeleteBlock,
    handleImport,
    handleToggleScope,
    // helpers
    agentLabel,
    allocatableAgents,
    isSelfChatMemory,
  } = store;

  const currentAgent = useMemo(
    () => ownedTeamAgents.find((a) => a.agent_id === agentFilter),
    [ownedTeamAgents, agentFilter],
  );

  const handleRenameAgent = async (newName: string) => {
    if (!currentAgent) return;
    try {
      await agentsApi.update(currentAgent.agent_id, { name: newName });
      tea.notify.success(t('memory.notify.renameSuccess'));
      setShowRename(false);
      invalidateBackendCache();
      fetchBlocks();
    } catch (err: unknown) {
      tea.notify.error(err instanceof Error ? err.message : t('memory.notify.renameFailed'));
    }
  };

  const handleDeleteAgent = async () => {
    if (!currentAgent) return;
    const ok = await tea.confirm({
      message: t('memory.confirm.deleteAgent', { name: currentAgent.name }),
      description: t('memory.confirm.deleteAgent.desc', { id: currentAgent.agent_id }),
      okText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await agentsApi.delete(currentAgent.agent_id);
      invalidateBackendCache();
      tea.notify.success(t('memory.notify.agentDeleted'));
      const remaining = ownedTeamAgents.filter((a) => a.agent_id !== currentAgent.agent_id);
      setAgentFilter(remaining[0]?.agent_id ?? '');
      fetchBlocks();
    } catch (err: unknown) {
      tea.notify.error(err instanceof Error ? err.message : t('memory.notify.deleteAgentFailed'));
    }
  };

  return (
    <div className="_asset-memory-page">
      <AssetPageHeader
        title={t('memory.title')}
        titleExtra={
          scopeTab === 'fixed' && repoUrl(currentAgent) ? (
            <a className="_asset-page-header-link" href={repoUrl(currentAgent)} target="_blank" rel="noreferrer">
              {repoUrl(currentAgent).replace(/^https?:\/\//, '')}
            </a>
          ) : undefined
        }
        subtitle={
          activeTeam
            ? t('memory.subtitle.team', { name: activeTeam.name, count: blocks.length })
            : t('memory.subtitle.global', { count: blocks.length })
        }
        scope={
          <Segment
            value={scopeTab}
            onChange={(v) => setScopeTab(v as ScopeTab)}
            options={(['team', 'fixed'] as ScopeTab[]).map((tab) => ({
              value: tab,
              text: scopeTabLabels[tab],
            }))}
          />
        }
        agent={
          scopeTab === 'fixed' ? (
            <Select
              appearance="button"
              value={agentFilter}
              onChange={setAgentFilter}
              disabled={ownedTeamAgents.length === 0}
              placeholder={t('memory.noAgent')}
              options={ownedTeamAgents.map((agent) => ({
                value: agent.agent_id,
                text: repoAgentLabel(agent, ownedTeamAgents),
              }))}
            />
          ) : undefined
        }
        actions={
          <>
            {scopeTab === 'fixed' && currentAgent && (
              <>
                <Button onClick={() => setShowRename(true)}>
                  {t('memory.renameAgent')}
                </Button>
                <Button type="error" onClick={handleDeleteAgent}>
                  {t('memory.deleteAgent')}
                </Button>
              </>
            )}
            {(() => {
              const isPrivateAndNotOwner =
                !!selected &&
                selected.scope === 'private' &&
                selected.uploaded_by_user_id !== currentUserId;
              const disabled = !selected || isPrivateAndNotOwner;
              const tooltip = !selected
                ? t('memory.allocate.disabled')
                : isPrivateAndNotOwner
                  ? t('memory.allocate.privateDisabled')
                  : undefined;
              return (
                <Button onClick={() => setShowAllocate(true)} disabled={disabled} tooltip={tooltip}>
                  {t('memory.allocateToAgent')}
                </Button>
              );
            })()}
            <Button
              type="primary"
              onClick={() => setShowImport(true)}
              disabled={ownedTeamAgents.length === 0}
              tooltip={
                ownedTeamAgents.length === 0 ? t('memory.import.tooltip.noAgent') : undefined
              }
              data-guide="import-memory"
            >
              {t('memory.import')}
            </Button>
          </>
        }
      />

      <AssetSplitLayout
        storageKey="memory:assetSplitWidth"
        sidebar={
            <AssetListPanel
              title={t('memory.blockList')}
              count={t('memory.blockCount', { filtered: filtered.length, total: blocks.length })}
              loading={blocksLoading}
              items={filtered}
              selectedId={selectedId}
              getItemId={(b) => b.id}
              onSelect={(b) => setSelectedId(b.id)}
              isItemDisabled={(b) =>
                scopeTab === 'fixed' &&
                b.scope === 'private' &&
                b.uploaded_by_user_id !== currentUserId
              }
              emptyText={t('memory.empty.filtered')}
              renderItem={(b) => {
                const isRevoked =
                  scopeTab === 'fixed' &&
                  b.scope === 'private' &&
                  b.uploaded_by_user_id !== currentUserId;
                const isOwner = b.uploaded_by_user_id === currentUserId;
                const canToggleScope = scopeTab === 'fixed' && isOwner && !!b.scope;
                const canUnbind = scopeTab === 'fixed' && !isSelfChatMemory(b);
                const l0Count = b.layer_counts?.L0_messages ?? 0;
                return (
                  <div className="_memory-card">
                    {/* 第 1 行：标题（左） + 蓝色计数徽章（右） */}
                    <div className="_memory-card-header">
                      <span className="_memory-card-title" title={b.title}>
                        {b.title}
                        {isRevoked && (
                          <span className="_memory-badge _memory-badge--warning">
                            {t('memory.list.revoked')}
                          </span>
                        )}
                      </span>
                      {l0Count > 0 && <span className="_memory-card-count">{l0Count}</span>}
                    </div>

                    {/* session 记忆块：所属 repo 标签 */}
                    <RepoTags repos={b.repos} />

                    {/* 第 2 行：资产真实 id，等宽灰色 */}
                    <div className="_memory-card-id" title={b.id}>{b.id}</div>

                    {/* 第 3 行：用户名（左） + 时间 / 解绑（右）
                        复用通用 AssetItemBadges + AssetItemTime，与 Skills 页结构一致 */}
                    <AssetItemBadges>
                      {b.uploaded_by_user_id && (
                        <UserBadge
                          userId={b.uploaded_by_user_id}
                          isCurrentUser={isOwner}
                          youText={t('common.you')}
                        />
                      )}
                      {isOwner && b.name && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenamingBlock({ id: b.id, name: b.name! });
                          }}
                          title={t('memory.renameBlock.tooltip')}
                          className="_memory-card-unbind _memory-card-rename"
                        >
                          {t('memory.renameBlock')}
                        </button>
                      )}
                      {canUnbind ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteBlock(b.id);
                          }}
                          title={t('memory.unbind.tooltip')}
                          className="_memory-card-unbind"
                        >
                          {t('memory.unbind')}
                        </button>
                      ) : (
                        <AssetItemTime>
                          {new Date(b.updated_at_ms).toLocaleString()}
                        </AssetItemTime>
                      )}
                    </AssetItemBadges>

                    {/* 第 4 行：共享/私密切换（仅 owner 可见） */}
                    {canToggleScope && (
                      <div
                        className="_memory-card-scope"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Segment
                          value={b.scope === 'team' ? 'team' : 'private'}
                          onChange={(v) => handleToggleScope(b, v as 'team' | 'private')}
                          options={[
                            { value: 'team', text: t('memoryPersonal.shared') },
                            { value: 'private', text: t('memoryPersonal.private') },
                          ]}
                        />
                      </div>
                    )}
                  </div>
                );
              }}
            />
          }
          detail={
            !selected ? (
              <div className="_memory-detail-empty-card">{t('memory.detail.empty')}</div>
            ) : (
              <BlockDetail
                block={selected}
                layer={layer}
                onLayerChange={setLayer}
                agentLabel={agentLabel}
                layerPage={layerPage}
                layerPageSize={pageSize}
                layerTotal={windowTotal}
                layerLoading={layerLoading}
                onLayerPageChange={handleLayerPageChange}
                onLayerItemLoad={handleLayerItemLoad}
                layerItemLoadingId={layerItemLoadingId}
                onL0LoadMore={handleL0LoadMore}
                l0MoreLoading={l0MoreLoading}
                timeRange={timeRange}
                onTimeRangeChange={setTimeRange}
                rangeTooLarge={rangeTooLarge}
                canEdit={selected.uploaded_by_user_id === currentUserId}
                onSaveLayerItem={handleSaveLayerItem}
                onSearchLayer={searchLayer}
                onRefresh={refreshLayer}
              />
            )
          }
      />

      {showRename && currentAgent && (
        <RenameAgentDialog
          agent={currentAgent}
          onClose={() => setShowRename(false)}
          onRenamed={handleRenameAgent}
        />
      )}

      {renamingBlock && (
        <RenameBlockDialog
          block={renamingBlock}
          onClose={() => setRenamingBlock(null)}
          onRenamed={async (newName) => {
            try {
              await chatMemoryApi.renameBlock(renamingBlock.id, newName);
              tea.notify.success(t('memory.notify.renameBlockSuccess'));
              setRenamingBlock(null);
              fetchBlocks();
            } catch (e: unknown) {
              tea.notify.error(e instanceof Error ? e.message : t('memory.notify.renameBlockFailed'));
            }
          }}
        />
      )}

      {showImport && (
        <ImportBlockDialog
          onClose={() => setShowImport(false)}
          onImported={handleImport}
          agents={ownedTeamAgents.map((a) => ({ agent_id: a.agent_id, name: a.name }))}
          defaultAgentId={scopeTab === 'fixed' && agentFilter ? agentFilter : ''}
        />
      )}

      {showAllocate && selected && (
        <AllocateMemoryDialog
          memoryTitle={selected.title}
          agents={allocatableAgents(selected)}
          memorySource="team"
          onClose={() => setShowAllocate(false)}
          onAllocated={async (agentId) => {
            try {
              await chatMemoryApi.allocate(activeTeamId!, selected.id, agentId);
              tea.notify.success(t('memory.notify.allocated'));
              setShowAllocate(false);
              fetchBlocks();
            } catch (e: any) {
              tea.notify.error(e?.message || t('memory.notify.allocateFailed'));
            }
          }}
        />
      )}
    </div>
  );
}
