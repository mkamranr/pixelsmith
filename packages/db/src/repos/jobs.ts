import { randomUUID } from 'node:crypto'
import { and, desc, eq, lte, ne } from 'drizzle-orm'
import type { Db } from '../client.js'
import { jobFiles, jobs, type Job, type JobFile } from '../schema.js'

/** How long finished job files survive before the sweeper deletes them. */
export const DEFAULT_RETENTION_MS = 2 * 60 * 60 * 1000

export interface JobsRepoOptions {
  now?: () => number
  retentionMs?: number
}

export interface CreateJobInput {
  /** Supply an id when files were staged on disk before the row was written. */
  id?: string
  userId: string
  toolId: string
  params: unknown
  retentionMs?: number
}

export interface NewJobFile {
  role: 'input' | 'output'
  name: string
  relPath: string
  mime: string
  bytes: number
}

export function jobsRepo(db: Db, options: JobsRepoOptions = {}) {
  const now = options.now ?? Date.now
  const defaultRetention = options.retentionMs ?? DEFAULT_RETENTION_MS

  const getJob = async (id: string): Promise<Job | undefined> =>
    db.select().from(jobs).where(eq(jobs.id, id)).get()

  return {
    getJob,

    async createJob(input: CreateJobInput): Promise<Job> {
      const retention = input.retentionMs ?? defaultRetention
      return db
        .insert(jobs)
        .values({
          id: input.id ?? randomUUID(),
          userId: input.userId,
          toolId: input.toolId,
          params: input.params as object,
          status: 'queued',
          progress: 0,
          // Set at creation as well as at completion: a job that is queued and
          // then abandoned still has to be swept.
          expiresAt: now() + retention,
          createdAt: now(),
        })
        .returning()
        .get()
    },

    /**
     * Fetch a job only if it belongs to this user. Job ids are UUIDs, but
     * authorisation must not rest on them being hard to guess.
     */
    async getJobForUser(id: string, userId: string): Promise<Job | undefined> {
      return db
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
        .get()
    },

    async listJobsForUser(userId: string, limit = 50): Promise<Job[]> {
      return db.select().from(jobs).where(eq(jobs.userId, userId)).orderBy(desc(jobs.createdAt)).limit(limit).all()
    },

    async markRunning(id: string): Promise<void> {
      db.update(jobs).set({ status: 'running', startedAt: now() }).where(eq(jobs.id, id)).run()
    },

    async updateProgress(id: string, progress: number): Promise<void> {
      const clamped = Math.max(0, Math.min(100, Math.round(progress)))
      db.update(jobs).set({ progress: clamped }).where(eq(jobs.id, id)).run()
    },

    async markDone(id: string, retentionMs?: number): Promise<void> {
      const finished = now()
      db.update(jobs)
        .set({
          status: 'done',
          progress: 100,
          finishedAt: finished,
          // Retention runs from completion, so a job that queued behind a long
          // backlog still gets its full download window.
          expiresAt: finished + (retentionMs ?? defaultRetention),
        })
        .where(eq(jobs.id, id))
        .run()
    },

    async markFailed(id: string, errorCode: string, errorMessage: string, retentionMs?: number): Promise<void> {
      const finished = now()
      db.update(jobs)
        .set({
          status: 'failed',
          errorCode,
          errorMessage,
          finishedAt: finished,
          expiresAt: finished + (retentionMs ?? defaultRetention),
        })
        .where(eq(jobs.id, id))
        .run()
    },

    async addFiles(jobId: string, files: NewJobFile[]): Promise<void> {
      if (files.length === 0) return
      db.insert(jobFiles)
        .values(files.map((f) => ({ id: randomUUID(), jobId, createdAt: now(), ...f })))
        .run()
    },

    async listFiles(jobId: string): Promise<JobFile[]> {
      return db.select().from(jobFiles).where(eq(jobFiles.jobId, jobId)).all()
    },

    async deleteJob(id: string): Promise<void> {
      db.delete(jobs).where(eq(jobs.id, id)).run()
    },

    /** Jobs whose files are due for deletion and have not been swept yet. */
    async findExpired(limit = 200): Promise<Job[]> {
      return db
        .select()
        .from(jobs)
        .where(and(lte(jobs.expiresAt, now()), ne(jobs.status, 'expired')))
        .limit(limit)
        .all()
    },

    async markExpired(id: string): Promise<void> {
      db.update(jobs).set({ status: 'expired', progress: 0 }).where(eq(jobs.id, id)).run()
    },
  }
}

export type JobsRepo = ReturnType<typeof jobsRepo>
