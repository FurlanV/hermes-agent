/**
 * "Learned skills" on the Athena Capabilities page (F02 slice 28): the skills the agent wrote for this user, which
 * the user can read and delete. There is no add, import, URL or edit path here.
 *
 * Reads go through the same REST the stock Skills tab uses (`GET /api/skills`, `GET /api/skills/content`); delete is
 * the stock archive (`DELETE /api/learning/node`, restorable with `hermes curator restore`). A learned skill is a
 * local skill (`provenance: agent`) that managed scope leaves on and that the catalog did not install: the applier
 * disables every local skill that is neither a catalog skill nor recorded as created by the agent.
 */

import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { parseFrontmatter } from '@/app/capabilities/skills/frontmatter'
import { skillsQueryKey, useSkillsQuery } from '@/app/capabilities/skills/skills-data'
import { archiveLearningSkill } from '@/app/learning/archive-skill-confirm-dialog'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { getSkillContent } from '@/hermes'
import { ChevronDown, ChevronRight, Starmap } from '@/lib/icons'
import { queryClient } from '@/lib/query-client'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'
import { notify, notifyError } from '@/store/notifications'
import type { SkillInfo } from '@/types/hermes'

import { catalogSkillIds } from './catalog'

/** The agent's own skills among the installed ones. */
export function learnedSkills(skills: readonly SkillInfo[], catalogSkills: ReadonlySet<string> = catalogSkillIds()) {
  return skills
    .filter(skill => skill.provenance === 'agent' && skill.enabled !== false && !catalogSkills.has(skill.name))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function SkillBody({ name }: { name: string }) {
  const content = useQuery({
    queryKey: ['skill-content', name, 'default'],
    queryFn: () => getSkillContent(name),
    staleTime: 60_000
  })

  if (content.isLoading) {
    return <p className="text-xs text-(--ui-text-tertiary)">Loading…</p>
  }

  if (content.isError || !content.data) {
    return <p className="text-xs text-destructive">Could not read this skill.</p>
  }

  return (
    <pre
      className="max-h-80 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-muted/40 p-2 font-mono text-[0.68rem] leading-relaxed text-(--ui-text-secondary)"
      data-selectable-text="true"
      data-slot="athena-learned-skill-body"
    >
      {parseFrontmatter(content.data.content).body.trim() || 'This skill has no instructions yet.'}
    </pre>
  )
}

export function LearnedSkills() {
  const { data, isError, isLoading } = useSkillsQuery(undefined)
  const learned = useMemo(() => learnedSkills(data ?? []), [data])
  const [open, setOpen] = useState(false)
  const [viewing, setViewing] = useState<null | string>(null)
  const [deleting, setDeleting] = useState<null | string>(null)

  const remove = async (name: string) => {
    const key = skillsQueryKey(undefined)
    const before = queryClient.getQueryData<SkillInfo[]>(key)
    await queryClient.cancelQueries({ exact: true, queryKey: key })
    queryClient.setQueryData<SkillInfo[]>(key, current => current?.filter(skill => skill.name !== name))

    if (viewing === name) {
      setViewing(null)
    }

    try {
      await archiveLearningSkill(name)
      invalidateSlashCompletions()
      notify({ kind: 'success', message: 'New chats no longer use it.', title: `Deleted ${name}` })
    } catch (error) {
      queryClient.setQueryData(key, before)
      notifyError(error, `Could not delete ${name}`)
    } finally {
      void queryClient.invalidateQueries({ exact: true, queryKey: key })
    }
  }

  return (
    <section aria-label="Learned skills" className="mt-6" data-slot="athena-learned-skills">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md py-1 text-left text-sm font-medium"
        onClick={() => setOpen(value => !value)}
        type="button"
      >
        <Starmap className="size-4 text-(--ui-text-tertiary)" />
        <span>Learned skills{data ? ` (${learned.length})` : ''}</span>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="font-normal text-xs text-(--ui-text-tertiary)">Skills the agent wrote for you</span>
      </button>
      {open && (
        <div className="mt-2 grid gap-2 pl-6">
          {isLoading && <p className="text-xs text-(--ui-text-tertiary)">Loading…</p>}
          {isError && <p className="text-xs text-destructive">Could not list your skills.</p>}
          {data && learned.length === 0 && (
            <p className="text-xs text-(--ui-text-tertiary)">
              None yet. When the agent saves a way of working as a skill, it shows up here.
            </p>
          )}
          {learned.map(skill => (
            <div
              className="rounded-lg border border-(--ui-stroke-secondary) px-3 py-2"
              data-skill={skill.name}
              key={skill.name}
            >
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{skill.name}</div>
                  {skill.description && (
                    <div className="truncate text-xs text-(--ui-text-secondary)">{skill.description}</div>
                  )}
                </div>
                <Button
                  aria-label={`View ${skill.name}`}
                  onClick={() => setViewing(current => (current === skill.name ? null : skill.name))}
                  size="xs"
                  variant="text"
                >
                  {viewing === skill.name ? 'Hide' : 'View'}
                </Button>
                <Button
                  aria-label={`Delete ${skill.name}`}
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleting(skill.name)}
                  size="xs"
                  variant="text"
                >
                  Delete
                </Button>
              </div>
              {viewing === skill.name && (
                <div className="mt-2">
                  <SkillBody name={skill.name} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          confirmLabel="Delete"
          description="New chats stop using it. It is archived, so Research IT can restore it."
          destructive
          dismissOnConfirm
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            void remove(deleting)
          }}
          open
          title={`Delete ${deleting}?`}
        />
      )}
    </section>
  )
}
