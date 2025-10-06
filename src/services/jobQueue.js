// job-queue.js
/* eslint-disable no-console */
/**
 * @file Refactored JobQueue
 * - Non-overlapping worker loop (hindari pekerjaan bertumpuk saat process lama)
 * - Konstanta terpusat utk status & tipe job
 * - Util waktu & JSON stringify aman
 * - Logging terstruktur & penanganan error konsisten
 * - Pengurangan duplikasi di penyimpanan progress setup
 */

const databaseService = require("./database");
const logger = require("../utils/logger");
const cloudpanelService = require("./cloudpanel");
const { Client } = require("ssh2");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

// pastikan semua output jadi string aman
const toText = (v) => (v == null ? "" : String(v));

/** ------------------------------ Constants ------------------------------ */
const JOB_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
});

const SETUP_STATUS = Object.freeze({
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
});

const JOB_TYPES = Object.freeze({
  SETUP_LARAVEL: "setup_laravel",
  SETUP_LARAVEL_STEP: "setup_laravel_step",
  GIT_PULL: "git_pull",
});

/** ------------------------------ Utilities ------------------------------ */
const nowISO = () => new Date().toISOString();

/** stringify aman utk object/error tanpa meledak karena circular */
const safeStringify = (val) => {
  if (val == null) return null;
  if (typeof val === "string") return val;
  try {
    return JSON.stringify(val);
  } catch (e) {
    return String(val);
  }
};

/** parse aman untuk payload job.data */
const safeParse = (json, fallback = {}) => {
  try {
    return JSON.parse(json);
  } catch (_) {
    return fallback;
  }
};

/** coerce boolean strict */
const asBool = (v) => v === true || v === "true" || v === 1 || v === "1";

/** ---------------------- SSH (dev-mode only) Helper --------------------- */
class SshExecutor {
  /**
   * @param {{enabled: boolean, host?: string, user?: string, port?: number, password?: string}} opts
   */
  constructor(opts) {
    this.enabled = !!opts?.enabled;
    this.host = opts?.host || "localhost";
    this.user = opts?.user || "root";
    this.port = Number(opts?.port || 22);
    this.password = opts?.password || null;
  }

  validate() {
    if (!this.enabled) return;
    if (!this.host) throw new Error("Development mode requires VPS_HOST");
    if (!this.user) throw new Error("Development mode requires VPS_USER");
    if (!this.password) throw new Error("Development mode requires VPS_PASSWORD");
  }

  connect() {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const t = setTimeout(() => {
        conn.destroy();
        reject(new Error("SSH connection timeout"));
      }, 10000);

      conn
        .on("ready", () => {
          clearTimeout(t);
          resolve(conn);
        })
        .on("error", (err) => {
          clearTimeout(t);
          reject(err);
        })
        .connect({
          host: this.host,
          port: this.port,
          username: this.user,
          password: this.password,
          readyTimeout: 10000,
          keepaliveInterval: 30000,
          keepaliveCountMax: 3,
        });
    });
  }

  /**
   * Eksekusi command via SSH (dev only). Production memakai exec local.
   * @param {string} command
   * @returns {Promise<{success:boolean, output:string, stderr:string, exitCode:number}>}
   */
  async exec(command) {
    if (!this.enabled) throw new Error("SSH execution only available in development mode");

    this.validate();
    const conn = await this.connect();

    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject({ success: false, error: `SSH exec error: ${err.message}`, command, stdout: "", stderr: "" });
        }
        let stdout = "";
        let stderr = "";
        stream
          .on("close", (code) => {
            conn.end();
            if (code !== 0) {
              reject({ success: false, error: `Command failed with exit code ${code}`, stdout, stderr, exitCode: code, command });
            } else {
              resolve({ success: true, output: stdout, stderr, exitCode: code, command });
            }
          })
          .on("data", (d) => (stdout += d.toString()))
          .stderr.on("data", (d) => (stderr += d.toString()));
      });
    });
  }
}

/** ----------------------------- Job Queue ------------------------------ */
class JobQueue {
  constructor() {
    this._running = false;
    this._loopAbort = null; // AbortController-like
  }

  /** -------------------------- Core DB helpers ------------------------- */
  async addJob(type, data, priority = 0) {
    const job = {
      type,
      data: safeStringify(data),
      status: JOB_STATUS.PENDING,
      priority,
      attempts: 0,
      max_attempts: 3,
      created_at: nowISO(),
      scheduled_at: nowISO(),
    };

    try {
      const result = await databaseService.createJob(job);
      logger.info(`Job added: ${type} #${result.id}`, { jobId: result.id, type, meta: data });
      return result;
    } catch (error) {
      logger.error("Failed to add job:", error);
      throw error;
    }
  }

  async getNextJob() {
    try {
      return await databaseService.getNextPendingJob();
    } catch (error) {
      logger.error("Failed to fetch next job:", error);
      return null;
    }
  }

  async updateJobStatus(jobId, status, result = null, error = null) {
    const payload = {
      status,
      updated_at: nowISO(),
    };
    if (result) payload.result = safeStringify(result);
    if (error) payload.error = typeof error === "string" ? error : safeStringify(error);
    if (status === JOB_STATUS.COMPLETED) payload.completed_at = nowISO();

    try {
      await databaseService.updateJob(jobId, payload);
      logger.info(`Job #${jobId} -> ${status}`);
    } catch (e) {
      logger.error(`Failed to update job #${jobId}:`, e);
    }
  }

  /** ----------------------- Setup Progress Helper ---------------------- */
  /**
   * Simpankan progress setup (mode: full flow / step-retry).
   * Mengurangi duplikasi kode update/create setup.
   * @param {'full'|'step'} mode
   * @param {object} ctx
   * @returns {Promise<{id:number,isUpdate?:boolean, skipped?:boolean}|null>}
   */
  async saveSetupProgress(mode, ctx) {
    const {
      job,
      data, // payload
      setupTracking, // flags & fields
      status, // SETUP_STATUS
      errorMessage = null,
    } = ctx;

    const track = { ...setupTracking, setupStatus: status, errorMessage };

    try {
      // STEP MODE: selalu update ke setupId yg sudah ada
      if (mode === "step") {
        const current = await databaseService.getSetupById(data.setupId);
        if (!current) {
          logger.error(`Setup ID ${data.setupId} not found`, { jobId: job.id });
          return null;
        }
        const updateData = {
          job_id: job.id,
          setup_status: status,
          error_message: errorMessage,
          site_created: track.siteCreated ? 1 : 0,
          database_created: track.databaseCreated ? 1 : 0,
          ssh_keys_copied: track.sshKeysCopied ? 1 : 0,
          repository_cloned: track.repositoryCloned ? 1 : 0,
          env_configured: track.envConfigured ? 1 : 0,
          laravel_setup_completed: track.laravelSetupCompleted ? 1 : 0,
        };
        await databaseService.updateSetup(data.setupId, updateData);
        logger.info(`Setup step '${data.retryStep}' updated #${data.setupId}`, {
          jobId: job.id,
          status,
          errorMessage,
          prevStatus: current.setup_status,
        });
        return { id: data.setupId, isUpdate: true };
      }

      // FULL MODE:
      if (data.isRetry && data.setupId) {
        const current = await databaseService.getSetupById(data.setupId);
        if (!current) {
          logger.error(`Setup ID ${data.setupId} not found`, { jobId: job.id });
          return null;
        }
        if (current.setup_status === SETUP_STATUS.COMPLETED && status !== SETUP_STATUS.COMPLETED) {
          logger.warn(`Skip downgrade completed -> ${status} for setup #${data.setupId}`, {
            jobId: job.id,
          });
          return { id: data.setupId, isUpdate: false, skipped: true };
        }
        const updateData = {
          job_id: job.id,
          setup_status: status,
          error_message: errorMessage,
          site_created: track.siteCreated ? 1 : 0,
          database_created: track.databaseCreated ? 1 : 0,
          ssh_keys_copied: track.sshKeysCopied ? 1 : 0,
          repository_cloned: track.repositoryCloned ? 1 : 0,
          env_configured: track.envConfigured ? 1 : 0,
          laravel_setup_completed: track.laravelSetupCompleted ? 1 : 0,
        };
        await databaseService.updateSetup(data.setupId, updateData);
        logger.info(`Setup updated #${data.setupId}`, { jobId: job.id, status, errorMessage });
        return { id: data.setupId, isUpdate: true };
      }

      const existing = await databaseService.getSetupByDomain(data.domainName);
      if (existing) {
        // Completed -> completed allowed; completed -> non-completed ditolak (buat baru gagal)
        if (existing.setup_status === SETUP_STATUS.COMPLETED && status === SETUP_STATUS.COMPLETED) {
          const updateData = {
            job_id: job.id,
            setup_status: status,
            error_message: errorMessage,
            site_created: track.siteCreated ? 1 : 0,
            database_created: track.databaseCreated ? 1 : 0,
            ssh_keys_copied: track.sshKeysCopied ? 1 : 0,
            repository_cloned: track.repositoryCloned ? 1 : 0,
            env_configured: track.envConfigured ? 1 : 0,
            laravel_setup_completed: track.laravelSetupCompleted ? 1 : 0,
          };
          await databaseService.updateSetup(existing.id, updateData);
          logger.info(`Updated completed setup #${existing.id} (completed→completed)`, {
            jobId: job.id,
          });
          return { id: existing.id, isUpdate: true };
        }

        if ([SETUP_STATUS.FAILED, SETUP_STATUS.IN_PROGRESS].includes(existing.setup_status)) {
          const updateData = {
            job_id: job.id,
            setup_status: status,
            error_message: errorMessage,
            site_created: track.siteCreated ? 1 : 0,
            database_created: track.databaseCreated ? 1 : 0,
            ssh_keys_copied: track.sshKeysCopied ? 1 : 0,
            repository_cloned: track.repositoryCloned ? 1 : 0,
            env_configured: track.envConfigured ? 1 : 0,
            laravel_setup_completed: track.laravelSetupCompleted ? 1 : 0,
          };
          await databaseService.updateSetup(existing.id, updateData);
          logger.info(`Updated existing setup #${existing.id}`, {
            jobId: job.id,
            prevStatus: existing.setup_status,
            newStatus: status,
          });
          return { id: existing.id, isUpdate: true };
        }

        // existing completed & new status non-completed → buat attempt baru (failed)
        if (existing.setup_status === SETUP_STATUS.COMPLETED && status !== SETUP_STATUS.COMPLETED) {
          const created = await databaseService.createSetup(track);
          logger.info(`Created new failed setup #${created.id} (existing completed)`, { jobId: job.id });
          return created;
        }
      }

      // no existing
      const created = await databaseService.createSetup(track);
      logger.info(`Setup created #${created.id}`, { jobId: job.id, status, errorMessage });
      return created;
    } catch (dbError) {
      logger.error(`saveSetupProgress error: ${dbError.message}`, {
        jobId: ctx?.job?.id,
        mode,
        status,
      });
      return null;
    }
  }

  /** -------------------------- Job Implementations --------------------- */
  async processSetupJob(job) {
    const start = Date.now();
    const data = safeParse(job.data);
    logger.info(`Setup job #${job.id} for ${data.domainName}`);

    const setupTracking = {
      jobId: job.id,
      domainName: data.domainName,
      phpVersion: data.phpVersion,
      vhostTemplate: data.vhostTemplate,
      siteUser: data.siteUser,
      databaseName: data.databaseName,
      databaseUserName: data.databaseUserName,
      databasePassword: data.databaseUserPassword,
      repositoryUrl: data.repositoryUrl || null,
      runMigrations: asBool(data.runMigrations),
      runSeeders: asBool(data.runSeeders),
      optimizeCache: asBool(data.optimizeCache),
      installComposer: asBool(data.installComposer),
      siteCreated: false,
      databaseCreated: false,
      sshKeysCopied: false,
      repositoryCloned: false,
      envConfigured: false,
      laravelSetupCompleted: false,
      setupStatus: SETUP_STATUS.IN_PROGRESS,
      errorMessage: null,
    };

    const formatNginxError = (payload) => {
      const detail =
        payload?.error ??
        payload?.message ??
        payload?.stderr ??
        payload?.stdout ??
        payload;
      const text = safeStringify(detail);
      if (!text) return "Unknown error";
      return text.trim() || "Unknown error";
    };

    const persist = async (status, message = null, mode = "full") =>
      this.saveSetupProgress(mode, { job, data, setupTracking, status, errorMessage: message });

    try {
      // 1) Create Site
      logger.site("info", `Create PHP site for ${data.domainName}`, {
        jobId: job.id,
        phpVersion: data.phpVersion,
        vhostTemplate: data.vhostTemplate,
        siteUser: data.siteUser,
      });

      const siteResult = await cloudpanelService.createSiteSetup(
        data.domainName,
        data.phpVersion,
        data.vhostTemplate,
        data.siteUser,
        data.siteUserPassword
      );
      if (!siteResult?.success) throw new Error(`Site creation failed: ${siteResult?.error || "Unknown"}`);
      setupTracking.siteCreated = true;
      logger.success("site", `Site created for ${data.domainName}`, { jobId: job.id });

      // 2) Database
      logger.info(`Create DB for ${data.domainName}`, { jobId: job.id });
      const dbResult = await cloudpanelService.createDatabaseSetup(
        data.domainName,
        data.databaseName,
        data.databaseUserName,
        data.databaseUserPassword
      );
      if (!dbResult?.success) {
        try {
          await cloudpanelService.deleteSite(data.domainName, true);
        } catch (cleanupErr) {
          logger.error(`Cleanup site failed: ${cleanupErr.message}`, { jobId: job.id });
        }
        throw new Error(`Database creation failed: ${dbResult?.error || "Unknown"}`);
      }
      setupTracking.databaseCreated = true;

      // 3) SSH keys (best-effort)
      logger.info(`Copy SSH keys to ${data.siteUser}`, { jobId: job.id });
      const sshRes = await cloudpanelService.copySshKeysToUser(data.siteUser);
      if (sshRes?.success) setupTracking.sshKeysCopied = true;
      else logger.error(`SSH copy failed: ${sshRes?.error}`, { jobId: job.id });

      // 4) Clone repo (optional)
      let cloned = false;
      if (data.repositoryUrl) {
        logger.info(`Clone repo ${data.repositoryUrl}`, { jobId: job.id });
        const cloneRes = await cloudpanelService.cloneRepository(
          data.domainName,
          data.repositoryUrl,
          data.siteUser
        );
        if (cloneRes?.success) {
          setupTracking.repositoryCloned = true;
          cloned = true;
        } else {
          logger.error(`Clone failed: ${cloneRes?.error}`, { jobId: job.id });
        }
      }

      // 5) Configure .env (only if repo cloned)
      let envOK = false;
      if (cloned) {
        logger.info(`Configure .env for ${data.domainName}`, { jobId: job.id });
        const envRes = await cloudpanelService.configureLaravelEnv(
          data.domainName,
          data.siteUser,
          {
            dbHost: "localhost",
            dbDatabase: data.databaseName,
            dbUsername: data.databaseUserName,
            dbPassword: data.databaseUserPassword,
            appUrl: `https://${data.domainName}`,
            appEnv: "production",
            appDebug: "false",
          }
        );
        if (envRes?.success) {
          setupTracking.envConfigured = true;
          envOK = true;
        } else {
          logger.error(`.env failed: ${envRes?.error}`, { jobId: job.id });
        }
      }

      // 6) Laravel setup (only if env OK)
      if (envOK) {
        logger.info(`Run Laravel setup for ${data.domainName}`, { jobId: job.id });
        const laravelRes = await cloudpanelService.runLaravelSetup(
          data.domainName,
          data.siteUser,
          {
            runMigrations: asBool(data.runMigrations),
            runSeeders: asBool(data.runSeeders),
            optimizeCache: asBool(data.optimizeCache),
            installComposer: asBool(data.installComposer),
          }
        );
        if (laravelRes?.success) {
          setupTracking.laravelSetupCompleted = true;
        } else {
          logger.error(`Laravel setup failed: ${laravelRes?.error}`, { jobId: job.id });
        }
      }

      let nginxRes;
      try {
        nginxRes = await cloudpanelService.safeNginxRestart();
      } catch (nginxError) {
        const message = formatNginxError(nginxError);
        logger.error(`Nginx restart failed: ${message}`, {
          jobId: job.id,
          command: nginxError?.command,
          exitCode: nginxError?.exitCode,
          stdout: nginxError?.stdout,
          stderr: nginxError?.stderr,
        });
        throw new Error(`Nginx restart failed: ${message}`);
      }

      if (!nginxRes?.success) {
        const message = formatNginxError(nginxRes);
        logger.error(`Nginx restart failed: ${message}`, {
          jobId: job.id,
          command: nginxRes?.command,
          exitCode: nginxRes?.exitCode,
          stdout: nginxRes?.stdout,
          stderr: nginxRes?.stderr,
        });
        throw new Error(`Nginx restart failed: ${message}`);
      }

      logger.info(`Nginx restart completed`, { jobId: job.id });

      // Persist & complete
      const saved = await persist(SETUP_STATUS.COMPLETED);
      const result = {
        setupId: saved?.id ?? null,
        domainName: data.domainName,
        status: SETUP_STATUS.COMPLETED,
        executionTime: Date.now() - start,
        steps: {
          siteCreated: setupTracking.siteCreated,
          databaseCreated: setupTracking.databaseCreated,
          sshKeysCopied: setupTracking.sshKeysCopied,
          repositoryCloned: setupTracking.repositoryCloned,
          envConfigured: setupTracking.envConfigured,
          laravelSetupCompleted: setupTracking.laravelSetupCompleted,
        },
      };
      await this.updateJobStatus(job.id, JOB_STATUS.COMPLETED, result);
      return result;
    } catch (error) {
      logger.error(`Setup job #${job.id} failed:`, error);
      const saved = await persist(SETUP_STATUS.FAILED, error.message);
      const result = {
        setupId: saved?.id ?? null,
        domainName: data.domainName,
        status: SETUP_STATUS.FAILED,
        executionTime: Date.now() - start,
        errorMessage: error.message || "Unknown error",
        steps: {
          siteCreated: setupTracking.siteCreated,
          databaseCreated: setupTracking.databaseCreated,
          sshKeysCopied: setupTracking.sshKeysCopied,
          repositoryCloned: setupTracking.repositoryCloned,
          envConfigured: setupTracking.envConfigured,
          laravelSetupCompleted: setupTracking.laravelSetupCompleted,
        },
      };
      await this.updateJobStatus(job.id, JOB_STATUS.FAILED, result, error.message);
      throw error;
    }
  }

  async processSetupStepJob(job) {
    const data = safeParse(job.data);
    const start = Date.now();
    logger.info(`Retry step '${data.retryStep}' for ${data.domainName}`, { jobId: job.id });

    const setupTracking = {
      jobId: job.id,
      domainName: data.domainName,
      phpVersion: data.phpVersion,
      vhostTemplate: data.vhostTemplate,
      siteUser: data.siteUser,
      siteUserPassword: data.siteUserPassword,
      databaseName: data.databaseName,
      databaseUserName: data.databaseUserName,
      databaseUserPassword: data.databaseUserPassword,
      repositoryUrl: data.repositoryUrl,
      runMigrations: asBool(data.runMigrations),
      runSeeders: asBool(data.runSeeders),
      optimizeCache: asBool(data.optimizeCache),
      installComposer: asBool(data.installComposer),
      setupStatus: SETUP_STATUS.IN_PROGRESS,
      errorMessage: null,
      // current states
      siteCreated: !!data.currentStepStates?.site_created,
      databaseCreated: !!data.currentStepStates?.database_created,
      sshKeysCopied: !!data.currentStepStates?.ssh_keys_copied,
      repositoryCloned: !!data.currentStepStates?.repository_cloned,
      envConfigured: !!data.currentStepStates?.env_configured,
      laravelSetupCompleted: !!data.currentStepStates?.laravel_setup_completed,
    };

    const persist = (status, message = null) =>
      this.saveSetupProgress("step", { job, data, setupTracking, status, errorMessage: message });

    try {
      const step = data.retryStep;
      logger.site("info", `Execute step: ${step} for ${data.domainName}`, {
        jobId: job.id,
        currentStates: data.currentStepStates,
      });

      switch (step) {
        case "site_created": {
          const res = await cloudpanelService.createSiteSetup(
            data.domainName,
            data.phpVersion,
            data.vhostTemplate,
            data.siteUser,
            data.siteUserPassword
          );
          if (!res?.success) throw new Error(res?.error || "Site creation failed");
          setupTracking.siteCreated = true;
          break;
        }
        case "database_created": {
          const res = await cloudpanelService.createDatabaseSetup(
            data.domainName,
            data.databaseName,
            data.databaseUserName,
            data.databaseUserPassword
          );
          if (!res?.success) throw new Error(res?.error || "DB creation failed");
          setupTracking.databaseCreated = true;
          break;
        }
        case "ssh_keys_copied": {
          const res = await cloudpanelService.copySshKeysToUser(data.siteUser);
          if (!res?.success) throw new Error(res?.error || "SSH copy failed");
          setupTracking.sshKeysCopied = true;
          break;
        }
        case "repository_cloned": {
          if (!data.repositoryUrl) throw new Error("repositoryUrl is required");
          const res = await cloudpanelService.cloneRepository(
            data.domainName,
            data.repositoryUrl,
            data.siteUser
          );
          if (!res?.success) throw new Error(res?.error || "Clone failed");
          setupTracking.repositoryCloned = true;
          break;
        }
        case "env_configured": {
          const envRes = await cloudpanelService.configureLaravelEnv(
            data.domainName,
            data.siteUser,
            {
              dbHost: "localhost",
              dbDatabase: data.databaseName,
              dbUsername: data.databaseUserName,
              dbPassword: data.databaseUserPassword,
              appUrl: `https://${data.domainName}`,
              appEnv: "production",
              appDebug: "false",
            }
          );
          if (!envRes?.success) throw new Error(envRes?.error || ".env failed");
          setupTracking.envConfigured = true;
          break;
        }
        case "laravel_setup_completed": {
          const res = await cloudpanelService.runLaravelSetup(
            data.domainName,
            data.siteUser,
            {
              runMigrations: asBool(data.runMigrations),
              runSeeders: asBool(data.runSeeders),
              optimizeCache: asBool(data.optimizeCache),
              installComposer: asBool(data.installComposer),
            }
          );
          if (!res?.success) throw new Error(res?.error || "Laravel setup failed");
          setupTracking.laravelSetupCompleted = true;
          break;
        }
        default:
          throw new Error(`Unknown setup step: ${step}`);
      }

      // final status
      const allDone =
        setupTracking.siteCreated &&
        setupTracking.databaseCreated &&
        setupTracking.sshKeysCopied &&
        setupTracking.repositoryCloned &&
        setupTracking.envConfigured &&
        setupTracking.laravelSetupCompleted;

      let finalStatus = allDone ? SETUP_STATUS.COMPLETED : SETUP_STATUS.FAILED;
      const current = await databaseService.getSetupById(data.setupId);
      if (current?.setup_status === SETUP_STATUS.COMPLETED && !allDone) {
        // jangan downgrade completed
        finalStatus = SETUP_STATUS.COMPLETED;
        logger.info(`Keep completed for setup #${data.setupId} after step retry`, { jobId: job.id });
      }

      const saved = await persist(finalStatus);
      const result = {
        setupId: saved?.id ?? null,
        domainName: data.domainName,
        step: data.retryStep,
        status: JOB_STATUS.COMPLETED,
        overallStatus: finalStatus,
        allStepsCompleted: allDone,
        executionTime: Date.now() - start,
        stepResult: `Step '${data.retryStep}' completed`,
        steps: {
          siteCreated: setupTracking.siteCreated,
          databaseCreated: setupTracking.databaseCreated,
          sshKeysCopied: setupTracking.sshKeysCopied,
          repositoryCloned: setupTracking.repositoryCloned,
          envConfigured: setupTracking.envConfigured,
          laravelSetupCompleted: setupTracking.laravelSetupCompleted,
        },
      };

      await this.updateJobStatus(job.id, JOB_STATUS.COMPLETED, result);
      return result;
    } catch (error) {
      logger.error(`Setup step job #${job.id} failed (${data.retryStep}):`, error);
      const saved = await persist(SETUP_STATUS.FAILED, error.message);
      const result = {
        setupId: saved?.id ?? null,
        domainName: data.domainName,
        step: data.retryStep,
        status: JOB_STATUS.FAILED,
        executionTime: Date.now() - start,
        errorMessage: error.message || "Unknown error",
        steps: {
          siteCreated: setupTracking.siteCreated,
          databaseCreated: setupTracking.databaseCreated,
          sshKeysCopied: setupTracking.sshKeysCopied,
          repositoryCloned: setupTracking.repositoryCloned,
          envConfigured: setupTracking.envConfigured,
          laravelSetupCompleted: setupTracking.laravelSetupCompleted,
        },
      };
      await this.updateJobStatus(job.id, JOB_STATUS.FAILED, result, error.message);
      throw error;
    }
  }

  async processGitPullJob(job) {
    const start = Date.now();
    const data = safeParse(job.data);
    const { siteUser, domainName, sitePath } = data;

    logger.info(`Git pull #${job.id} ${domainName}`);

    const isDevelopment = process.env.NODE_ENV === "development";
    const ssh = new SshExecutor({
      enabled: isDevelopment,
      host: process.env.VPS_HOST,
      user: process.env.VPS_USER,
      port: process.env.VPS_PORT,
      password: process.env.VPS_PASSWORD,
    });

    const sshCommand = 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null';

    const run = async (command, allowStderr = false) => {
      if (isDevelopment) {
        try {
          const out = await ssh.exec(command);
          return toText(out?.output);
        } catch (e) {
          if (allowStderr) {
            return toText(`${e?.stdout || ""}\n${e?.stderr || ""}\n${e?.error || ""}`);
          }
          throw e;
        }
      }
      try {
        const res = await execAsync(command);
        return toText(res?.stdout);
      } catch (e) {
        if (allowStderr) return toText(`${e?.stdout || ""}\n${e?.stderr || ""}`);
        throw e;
      }
    };

    try {
      // info
      const gitInfoCmd =
        `su - ${siteUser} -c 'cd "${sitePath}" && ` +
        `echo "=== Current Branch ===" && GIT_SSH_COMMAND="${sshCommand}" git branch --show-current && ` +
        `echo "=== Remote Info ===" && GIT_SSH_COMMAND="${sshCommand}" git remote -v && ` +
        `echo "=== Status Before Pull ===" && GIT_SSH_COMMAND="${sshCommand}" git status --porcelain'`;
      const gitInfo = toText(await run(gitInfoCmd, true)).trim();

      // pull (fetch + hard reset + pull)
      const gitPullCmd =
        `su - ${siteUser} -c 'cd "${sitePath}" && ` +
        `GIT_SSH_COMMAND="${sshCommand}" git fetch origin && ` +
        `git reset --hard origin/$(git branch --show-current) && ` +
        `git pull origin $(git branch --show-current) 2>&1'`;
      const pullOutput = toText(await run(gitPullCmd, true)).trim();

      // optimize (laravel)
      const optimizeCmd =
        `su - ${siteUser} -c 'cd "${sitePath}" && ` +
        `if [ -f "artisan" ]; then ` +
        `echo "=== Running Laravel optimizations ===" && ` +
        `composer install --no-dev --prefer-dist --optimize-autoloader --classmap-authoritative --quiet 2>&1 && ` +
        `php artisan optimize:clear && php artisan migrate --force 2>&1 && ` +
        `echo "Laravel optimizations completed"; ` +
        `else echo "Not a Laravel project, skipping optimizations"; fi'`;
      const optimizationOutput = toText(await run(optimizeCmd, true)).trim();

      // final status
      const statusAfterCmd =
        `su - ${siteUser} -c 'cd "${sitePath}" && ` +
        `echo "=== Status After Pull ===" && GIT_SSH_COMMAND="${sshCommand}" git status --porcelain && ` +
        `echo "=== Latest Commits ===" && GIT_SSH_COMMAND="${sshCommand}" git log --oneline -5'`;
      const statusAfter = toText(await run(statusAfterCmd, true)).trim();

      const ok =
        pullOutput.includes("Already up to date") ||
        pullOutput.includes("Fast-forward") ||
        pullOutput.includes("Updating") ||
        (!pullOutput.toLowerCase().includes("error") && !pullOutput.toLowerCase().includes("fatal"));

      const result = {
        domainName,
        siteUser,
        sitePath,
        status: ok ? JOB_STATUS.COMPLETED : "completed_with_issues",
        executionTime: Date.now() - start,
        gitInfo,
        pullOutput,
        optimizationOutput,
        statusAfter,
        timestamp: nowISO(),
      };

      logger.info(`Git pull #${job.id} ${ok ? "OK" : "with issues"} for ${domainName}`);
      await this.updateJobStatus(job.id, JOB_STATUS.COMPLETED, result);
      return result;
    } catch (error) {
      logger.error(`Git pull #${job.id} failed (${domainName}):`, error);
      const result = {
        domainName,
        siteUser,
        sitePath,
        status: JOB_STATUS.FAILED,
        executionTime: Date.now() - start,
        errorMessage: error.message || "Unknown error",
        timestamp: nowISO(),
      };
      await this.updateJobStatus(job.id, JOB_STATUS.FAILED, result, error.message);
      throw error;
    }
  }

  /** --------------------------- Dispatcher ----------------------------- */
  async processJob(job) {
    try {
      await this.updateJobStatus(job.id, JOB_STATUS.PROCESSING);

      switch (job.type) {
        case JOB_TYPES.SETUP_LARAVEL:
          return await this.processSetupJob(job);
        case JOB_TYPES.SETUP_LARAVEL_STEP:
          return await this.processSetupStepJob(job);
        case JOB_TYPES.GIT_PULL:
          return await this.processGitPullJob(job);
        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }
    } catch (error) {
      const attempts = (job.attempts || 0) + 1;

      if (attempts >= (job.max_attempts || 3)) {
        await this.updateJobStatus(job.id, JOB_STATUS.FAILED, null, error.message);
        logger.error(`Job #${job.id} permanently failed after ${attempts} attempts`, error);
      } else {
        const retryDelayMs = Math.pow(2, attempts) * 60000; // expo backoff (1m, 2m, 4m, ...)
        const scheduled_at = new Date(Date.now() + retryDelayMs).toISOString();
        await databaseService.updateJob(job.id, {
          status: JOB_STATUS.PENDING,
          attempts,
          scheduled_at,
          error: error.message,
        });
        logger.warn(`Job #${job.id} retry in ${retryDelayMs / 1000}s (attempt ${attempts}/${job.max_attempts})`, {
          error: error.message,
        });
      }
      throw error;
    }
  }

  /** --------------------------- Worker Loop ---------------------------- */
  /**
   * Worker loop tanpa overlap (no setInterval overlap).
   * @param {number} intervalMs jeda polling saat antrian ada pekerjaan (default 5000)
   * @param {number} idleDelayMs jeda saat tidak ada job (default 2000)
   */
  async startWorker(intervalMs = 5000, idleDelayMs = 2000) {
    if (this._running) {
      logger.warn("Queue worker already running");
      return;
    }
    this._running = true;
    const token = { stop: false };
    this._loopAbort = token;

    logger.info(`Queue worker started (interval=${intervalMs}ms idle=${idleDelayMs}ms)`);

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    while (!token.stop) {
      try {
        const job = await this.getNextJob();
        if (job) {
          logger.info(`Processing job #${job.id} (${job.type})`);
          await this.processJob(job);
          await sleep(50); // micro-rest
        } else {
          await sleep(idleDelayMs);
        }
      } catch (err) {
        logger.error("Worker loop error:", err);
        await sleep(intervalMs);
      }
    }

    logger.info("Queue worker stopped");
  }

  stopWorker() {
    if (!this._running) return;
    this._running = false;
    if (this._loopAbort) this._loopAbort.stop = true;
  }

  /** ----------------------------- Queries ------------------------------ */
  async getJobStatus(jobId) {
    try {
      return await databaseService.getJob(jobId);
    } catch (error) {
      logger.error(`Failed to get job #${jobId}:`, error);
      return null;
    }
  }

  async getJobs(filters = {}) {
    try {
      return await databaseService.getJobs(filters);
    } catch (error) {
      logger.error("Failed to get jobs:", error);
      return [];
    }
  }
}

module.exports = new JobQueue();
// module.exports.JobQueue = JobQueue; // optional: export class untuk testing
