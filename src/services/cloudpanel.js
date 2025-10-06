const { exec } = require("child_process");
const { Client } = require("ssh2");
const logger = require("../utils/logger");
const ResponseUtils = require("../utils/responseUtils");
const { API_NODE_URL } = require('../config');

class CloudPanelService {
  constructor() {
    this.clpctlPath = process.env.CLPCTL_PATH || "clpctl"; // Configurable path

    // SSH configuration for development mode
    this.isDevelopment = process.env.NODE_ENV === "development";
    this.sshConfig = {
      host: process.env.VPS_HOST || "localhost",
      user: process.env.VPS_USER || "root",
      port: process.env.VPS_PORT || 22,
      password: process.env.VPS_PASSWORD || null,
    };
  }

  /**
   * Execute a CloudPanel CLI command
   * @param {string} command - The clpctl command to execute
   * @param {Array} args - Array of command arguments
   * @param {Object} options - Additional options for command execution
   * @returns {Promise} - Promise that resolves with command output
   */
  async executeCommand(command, args = [], options = {}) {
    // Validate SSH configuration in development mode
    if (!this.validateSshConfig()) {
      const errorDetails = {
        command: command,
        args: args,
        sshConfig: {
          host: this.sshConfig.host,
          user: this.sshConfig.user,
          port: this.sshConfig.port,
        },
      };

      logger.failure(
        "cli",
        "Invalid SSH configuration for development mode",
        errorDetails
      );

      return Promise.reject({
        success: false,
        error: ResponseUtils.formatError({
          error: "Invalid SSH configuration for development mode",
          stderr: "Please check VPS_HOST and other SSH environment variables",
        }),
        command: "",
        exitCode: 1,
      });
    }

    const baseCommand = `${this.clpctlPath} ${command} ${args.join(" ")}`;

    if (this.isDevelopment && this.sshConfig.host) {
      // Use SSH client for development mode
      if (options.input) {
        return this.executeSshCommandWithInput(baseCommand, options.input);
      } else {
        return this.executeSshCommand(baseCommand);
      }
    } else {
      return new Promise((resolve, reject) => {
        const execOptions = {
          timeout: 120000,
          ...options,
        };

        const childProcess = exec(
          baseCommand,
          execOptions,
          (error, stdout, stderr) => {
            if (error) {
              const errorDetails = {
                command: baseCommand,
                exitCode: error.code,
                stdout: stdout,
                stderr: stderr,
                errorMessage: error.message,
                timeout: execOptions.timeout,
              };

              logger.failure(
                "cli",
                `CloudPanel CLI command failed: ${command}`,
                errorDetails
              );

              // Parse the error output to extract meaningful error messages
              const output = stdout + stderr;
              let parsedError = this.parseErrorMessage(output, error.message);

              reject({
                success: false,
                error: parsedError,
                command: baseCommand,
                exitCode: error.code,
                stdout: stdout,
                stderr: stderr,
                fullOutput: output,
              });
            } else {
              const successDetails = {
                command: baseCommand,
                exitCode: 0,
                hasStdout: !!stdout,
                hasStderr: !!stderr,
                outputLength: stdout ? stdout.length : 0,
              };

              logger.success(
                "cli",
                `CloudPanel CLI command completed successfully: ${command}`,
                successDetails
              );

              const result = {
                success: true,
                output: stdout || "Command completed successfully",
                stderr: stderr,
                command: baseCommand,
                exitCode: 0,
              };

              // Try to parse CLI output if available
              if (stdout) {
                try {
                  const parsedOutput = ResponseUtils.parseCliOutput(stdout);
                  resolve(parsedOutput);
                } catch (parseError) {
                  logger.warning(
                    "cli",
                    `Failed to parse CLI output for command: ${command}`,
                    {
                      command: baseCommand,
                      parseError: parseError.message,
                      rawOutput: stdout,
                    }
                  );
                  // If parsing fails, return raw output
                  resolve(result);
                }
              } else {
                resolve(result);
              }
            }
          }
        );

        // If input is provided for interactive commands, send it
        if (options.input) {
          childProcess.stdin.write(options.input);
          childProcess.stdin.end();
        }
      });
    }
  }

  /**
   * Build command arguments from object
   * @param {Object} params - Parameters object
   * @returns {Array} - Array of formatted command arguments
   */
  buildArgs(params) {
    const args = [];
    // Parameters that need to be wrapped in single quotes
    const quotedParams = [
      "siteUserPassword",
      "databaseUserPassword",
      "vhostTemplate",
    ];

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        if (quotedParams.includes(key)) {
          args.push(`--${key}='${value}'`);
        } else {
          args.push(`--${key}=${value}`);
        }
      }
    }
    return args;
  }

  /**
   * Execute command via SSH using ssh2 client
   * @param {string} command - The command to execute
   * @returns {Promise} - Promise that resolves with command output
   */
  async executeSshCommand(command) {
    return new Promise((resolve, reject) => {
      const conn = new Client();

      conn
        .on("ready", () => {
          logger.info(`SSH connected to ${this.sshConfig.host}`);

          conn.exec(command, (err, stream) => {
            if (err) {
              conn.end();
              return reject({
                success: false,
                error: `SSH exec error: ${err.message}`,
                command: command,
                exitCode: 1,
              });
            }

            let stdout = "";
            let stderr = "";

            stream
              .on("close", (code, signal) => {
                conn.end();
                logger.info(`STDOUT: ${stdout}`);
                if (stderr) {
                  logger.warn(`STDERR: ${stderr}`);
                }

                // Check for specific error patterns even with exit code 0
                const output = stdout + stderr;
                const hasError =
                  output.toLowerCase().includes("error") ||
                  output.toLowerCase().includes("failed") ||
                  output.includes("This value already exists") ||
                  output.includes("already exists");

                if (code !== 0 || hasError) {
                  logger.error(
                    `SSH command failed with code ${code}: ${command}`,
                    output
                  );

                  // Parse error output for better error messages
                  const parsedError = this.parseErrorMessage(
                    output,
                    hasError
                      ? `Command error detected: ${output.trim()}`
                      : `Command failed with exit code ${code}`
                  );

                  reject({
                    success: false,
                    error: parsedError,
                    command: command,
                    exitCode: code,
                    stdout: stdout,
                    stderr: stderr,
                    fullOutput: output,
                  });
                } else {
                  logger.info(`SSH command succeeded: ${command}`);
                  const result = {
                    success: true,
                    output: stdout || "Command completed successfully",
                    stderr: stderr,
                    command: command,
                    exitCode: code,
                  };

                  // Try to parse CLI output if available
                  if (stdout) {
                    try {
                      const parsedOutput = ResponseUtils.parseCliOutput(stdout);
                      resolve(parsedOutput);
                    } catch (parseError) {
                      // If parsing fails, return raw output
                      resolve(result);
                    }
                  } else {
                    resolve(result);
                  }
                }
              })
              .on("data", (data) => {
                stdout += data.toString();
              })
              .stderr.on("data", (data) => {
                stderr += data.toString();
              });
          });
        })
        .on("error", (err) => {
          logger.error(`SSH connection error: ${err.message}`, err);
          reject({
            success: false,
            error: `SSH connection failed: ${err.message}`,
            command: command,
            exitCode: 1,
          });
        })
        .connect({
          host: this.sshConfig.host,
          port: this.sshConfig.port,
          username: this.sshConfig.user,
          password: this.sshConfig.password,
          readyTimeout: 30000,
        });
    });
  }

  /**
   * Execute command via SSH with input support
   * @param {string} command - The command to execute
   * @param {string} input - Input to send to the command
   * @returns {Promise} - Promise that resolves with command output
   */
  async executeSshCommandWithInput(command, input) {
    return new Promise((resolve, reject) => {
      const conn = new Client();

      conn
        .on("ready", () => {
          conn.exec(command, (err, stream) => {
            if (err) {
              conn.end();
              return reject({
                success: false,
                error: `SSH exec error: ${err.message}`,
                command: command,
                exitCode: 1,
              });
            }

            let stdout = "";
            let stderr = "";

            // Send input if provided
            if (input) {
              stream.write(input);
              stream.end();
            }

            stream
              .on("close", (code, signal) => {
                conn.end();
                logger.info(`STDOUT: ${stdout}`);
                if (stderr) {
                  logger.warn(`STDERR: ${stderr}`);
                }

                // Check for specific error patterns even with exit code 0
                const output = stdout + stderr;
                const hasError =
                  output.toLowerCase().includes("error") ||
                  output.toLowerCase().includes("failed") ||
                  output.includes("This value already exists") ||
                  output.includes("already exists");

                if (code !== 0 || hasError) {
                  logger.error(
                    `SSH command failed with code ${code}: ${command}`,
                    output
                  );

                  // Parse error output for better error messages
                  const parsedError = this.parseErrorMessage(
                    output,
                    hasError
                      ? `Command error detected: ${output.trim()}`
                      : `Command failed with exit code ${code}`
                  );

                  reject({
                    success: false,
                    error: parsedError,
                    command: command,
                    exitCode: code,
                    stdout: stdout,
                    stderr: stderr,
                    fullOutput: output,
                  });
                } else {
                  logger.info(`SSH command succeeded: ${command}`);
                  const result = {
                    success: true,
                    output: stdout || "Command completed successfully",
                    stderr: stderr,
                    command: command,
                    exitCode: code,
                  };

                  // Try to parse CLI output if available
                  if (stdout) {
                    try {
                      const parsedOutput = ResponseUtils.parseCliOutput(stdout);
                      resolve(parsedOutput);
                    } catch (parseError) {
                      // If parsing fails, return raw output
                      resolve(result);
                    }
                  } else {
                    resolve(result);
                  }
                }
              })
              .on("data", (data) => {
                stdout += data.toString();
              })
              .stderr.on("data", (data) => {
                stderr += data.toString();
              });
          });
        })
        .on("error", (err) => {
          logger.error(`SSH connection error: ${err.message}`, err);
          reject({
            success: false,
            error: `SSH connection failed: ${err.message}`,
            command: command,
            exitCode: 1,
          });
        })
        .connect({
          host: this.sshConfig.host,
          port: this.sshConfig.port,
          username: this.sshConfig.user,
          password: this.sshConfig.password,
          readyTimeout: 30000,
        });
    });
  }

  /**
   * Validate SSH configuration in development mode
   * @returns {boolean} - True if SSH config is valid or not in development mode
   */
  validateSshConfig() {
    if (!this.isDevelopment) {
      return true;
    }

    if (!this.sshConfig.host) {
      logger.error("Development mode requires VPS_HOST environment variable");
      return false;
    }

    if (!this.sshConfig.user) {
      logger.error("Development mode requires VPS_USER environment variable");
      return false;
    }

    if (!this.sshConfig.password) {
      logger.error(
        "Development mode requires VPS_PASSWORD environment variable"
      );
      return false;
    }

    return true;
  }

  /**
   * Parse error output to extract meaningful error messages
   * @param {string} output - The combined stdout and stderr output
   * @param {string} defaultError - Default error message if no pattern matches
   * @returns {string} - Parsed error message
   */
  parseErrorMessage(output, defaultError = "Command failed") {
    if (!output || typeof output !== "string") {
      return defaultError;
    }

    // Check for specific error patterns
    if (
      output.includes("This value already exists") ||
      output.includes("already exists")
    ) {
      // Try to extract multiple field errors
      const errors = [];
      const lines = output.split("\n");

      for (const line of lines) {
        // Match patterns like "fieldName: This value already exists" with optional prefixes
        const fieldErrorMatch = line.match(
          /(?:Error:\s*)?(\w+):\s*This value already exists/
        );
        if (fieldErrorMatch) {
          errors.push(`${fieldErrorMatch[1]}: This value already exists.`);
        } else if (
          line.includes(": This value already exists") ||
          line.includes(": already exists")
        ) {
          // Clean up the line by removing common prefixes
          const cleanedLine = line
            .replace(/^(Error:\s*|Warning:\s*|Info:\s*)/i, "")
            .trim();
          errors.push(cleanedLine);
        }
      }

      if (errors.length > 0) {
        return errors.join("\n");
      }

      // Fallback to single field detection in the entire output
      const fieldMatches = output.match(/(\w+):\s*This value already exists/g);
      if (fieldMatches) {
        return fieldMatches
          .map((match) => {
            const fieldMatch = match.match(
              /(\w+):\s*This value already exists/
            );
            return `${fieldMatch[1]}: This value already exists.`;
          })
          .join("\n");
      }

      // Legacy fallback for single field detection
      if (output.includes("domainName")) {
        return "domainName: This value already exists.";
      } else if (output.includes("databaseName")) {
        return "databaseName: This value already exists.";
      } else if (output.includes("databaseUserName")) {
        return "databaseUserName: This value already exists.";
      } else if (output.includes("userName")) {
        return "userName: This value already exists.";
      } else if (output.includes("siteUser")) {
        return "siteUser: This value already exists.";
      } else {
        return "This value already exists.";
      }
    } else if (output.includes("Invalid PHP version")) {
      return "phpVersion: Invalid PHP version specified.";
    } else if (output.includes("Template not found")) {
      return "vhostTemplate: Template not found.";
    } else if (output.includes("Domain not found")) {
      return "domainName: Domain not found.";
    } else if (output.includes("Invalid database name")) {
      return "databaseName: Invalid database name.";
    } else if (output.includes("Invalid username")) {
      return "userName: Invalid username.";
    } else if (output.toLowerCase().includes("error")) {
      // Try to extract error message from output
      const errorMatch = output.match(/error[:\s]+(.+?)[\n\r]/i);
      if (errorMatch) {
        return errorMatch[1].trim();
      } else {
        // Look for lines that contain error information
        const lines = output.split("\n");
        for (const line of lines) {
          if (line.toLowerCase().includes("error") && line.trim()) {
            return line.trim();
          }
        }
      }
    }

    // If no specific pattern matches, try to clean up the output
    const cleanedOutput = output
      .trim()
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ");
    return cleanedOutput || defaultError;
  }

  /**
   * Handle SSH command execution result and format errors consistently
   * @param {number} code - Exit code
   * @param {string} stdout - Standard output
   * @param {string} stderr - Standard error
   * @param {string} command - The command that was executed
   * @returns {Object} - Formatted result object
   */
  handleSshResult(code, stdout, stderr, command) {
    const output = stdout + stderr;
    const hasError =
      output.toLowerCase().includes("error") ||
      output.toLowerCase().includes("failed") ||
      output.includes("This value already exists") ||
      output.includes("already exists");

    if (code !== 0 || hasError) {
      logger.error(`SSH command failed with code ${code}: ${command}`);

      const parsedError = this.parseErrorMessage(
        output,
        `Command failed with exit code ${code}`
      );

      return {
        success: false,
        error: parsedError,
        command: command,
        exitCode: code,
        stdout: stdout,
        stderr: stderr,
        fullOutput: output,
      };
    } else {
      const result = {
        success: true,
        output: stdout || "Command completed successfully",
        stderr: stderr,
        command: command,
        exitCode: code,
      };

      // Try to parse CLI output if available
      if (stdout) {
        try {
          const parsedOutput = ResponseUtils.parseCliOutput(stdout);
          return parsedOutput;
        } catch (parseError) {
          // If parsing fails, return raw output
          return result;
        }
      } else {
        return result;
      }
    }
  }

  // Cloudflare methods
  async updateCloudflareIps() {
    return this.executeCommand("cloudflare:update:ips");
  }

  // CloudPanel methods
  async enableBasicAuth(userName, password) {
    const args = this.buildArgs({ userName, password });
    return this.executeCommand("cloudpanel:enable:basic-auth", args);
  }

  async disableBasicAuth() {
    return this.executeCommand("cloudpanel:disable:basic-auth");
  }

  // Database methods
  async showMasterCredentials() {
    return this.executeCommand("db:show:master-credentials");
  }

  async addDatabase(
    domainName,
    databaseName,
    databaseUserName,
    databaseUserPassword
  ) {
    const args = this.buildArgs({
      domainName,
      databaseName,
      databaseUserName,
      databaseUserPassword,
    });
    // clpctl db:add --domainName=bill.aksess.my.id --databaseName=setup --databaseUserName=setup --databaseUserPassword='!secretPassword!'
    return this.executeCommand("db:add", args);
  }

  async exportDatabase(databaseName, file) {
    const args = this.buildArgs({ databaseName, file });
    return this.executeCommand("db:export", args);
  }

  async importDatabase(databaseName, file) {
    const args = this.buildArgs({ databaseName, file });
    return this.executeCommand("db:import", args);
  }

  // Let's Encrypt methods
  async installLetsEncryptCertificate(
    domainName,
    subjectAlternativeName = null
  ) {
    const params = { domainName };
    if (subjectAlternativeName) {
      params.subjectAlternativeName = subjectAlternativeName;
    }
    const args = this.buildArgs(params);
    return this.executeCommand("lets-encrypt:install:certificate", args);
  }

  // Site methods
  async addNodejsSite(
    domainName,
    nodejsVersion,
    appPort,
    siteUser,
    siteUserPassword
  ) {
    const args = this.buildArgs({
      domainName,
      nodejsVersion,
      appPort,
      siteUser,
      siteUserPassword,
    });
    return this.executeCommand("site:add:nodejs", args);
  }

  async addPhpSite(
    domainName,
    phpVersion,
    vhostTemplate,
    siteUser,
    siteUserPassword
  ) {
    const args = this.buildArgs({
      domainName,
      phpVersion,
      vhostTemplate,
      siteUser,
      siteUserPassword,
    });
    return this.executeCommand("site:add:php", args);
  }

  async addPythonSite(
    domainName,
    pythonVersion,
    appPort,
    siteUser,
    siteUserPassword
  ) {
    const args = this.buildArgs({
      domainName,
      pythonVersion,
      appPort,
      siteUser,
      siteUserPassword,
    });
    return this.executeCommand("site:add:python", args);
  }

  async addStaticSite(domainName, siteUser, siteUserPassword) {
    const args = this.buildArgs({
      domainName,
      siteUser,
      siteUserPassword,
    });
    return this.executeCommand("site:add:static", args);
  }

  async addReverseProxy(
    domainName,
    reverseProxyUrl,
    siteUser,
    siteUserPassword
  ) {
    const args = this.buildArgs({
      domainName,
      reverseProxyUrl,
      siteUser,
      siteUserPassword,
    });
    return this.executeCommand("site:add:reverse-proxy", args);
  }

  async installSiteCertificate(
    domainName,
    privateKey,
    certificate,
    certificateChain = null
  ) {
    const params = { domainName, privateKey, certificate };
    if (certificateChain) {
      params.certificateChain = certificateChain;
    }
    const args = this.buildArgs(params);
    return this.executeCommand("site:install:certificate", args);
  }

  async deleteSite(domainName, force = true) {
    const args = this.buildArgs({ domainName });

    // Always use force by default to avoid hanging on confirmation prompt
    // In an API context, we don't want interactive prompts
    if (force) {
      args.push("--force");
      return this.executeCommand("site:delete", args);
    } else {
      // If force is explicitly set to false, provide "yes" as input for confirmation
      return this.executeCommand("site:delete", args, { input: "yes\n" });
    }
  }

  // User methods
  async addUser(userData) {
    const args = this.buildArgs(userData);
    return this.executeCommand("user:add", args);
  }

  async deleteUser(userName, force = true) {
    const args = this.buildArgs({ userName });

    // Always use force by default for API consistency
    // Note: Check if user:delete command supports --force flag
    if (force) {
      // Some delete commands may not support --force, so we'll try with input first
      return this.executeCommand("user:delete", args, { input: "yes\n" });
    } else {
      return this.executeCommand("user:delete", args, { input: "yes\n" });
    }
  }

  async listUsers() {
    return this.executeCommand("user:list");
  }

  async resetPassword(userName, password) {
    const args = this.buildArgs({ userName, password });
    return this.executeCommand("user:reset:password", args);
  }

  async disableMfa(userName) {
    const args = this.buildArgs({ userName });
    return this.executeCommand("user:disable:mfa", args);
  }

  // Vhost Template methods
  async importVhostTemplates() {
    return this.executeCommand("vhost-templates:import");
  }

  async listVhostTemplates() {
    return this.executeCommand("vhost-templates:list");
  }

  async addVhostTemplate(name, file) {
    const args = this.buildArgs({ name, file });
    return this.executeCommand("vhost-template:add", args);
  }

  async deleteVhostTemplate(name, force = true) {
    const args = this.buildArgs({ name });

    // Provide confirmation input to avoid hanging on prompts
    if (force) {
      return this.executeCommand("vhost-template:delete", args, {
        input: "yes\n",
      });
    } else {
      return this.executeCommand("vhost-template:delete", args, {
        input: "yes\n",
      });
    }
  }

  async viewVhostTemplate(name) {
    const args = this.buildArgs({ name });
    return this.executeCommand("vhost-template:view", args);
  }

  /**
   * Create a site setup with PHP
   * @param {string} domainName - The domain name for the site
   * @param {string} phpVersion - The PHP version to use
   * @param {string} vhostTemplate - The vhost template to use
   * @param {string} siteUser - The user for the site
   * @param {string} siteUserPassword - The password for the site user
   * @returns {Promise} - Promise that resolves with command output
   */
  async createSiteSetup(
    domainName,
    phpVersion,
    vhostTemplate,
    siteUser,
    siteUserPassword
  ) {
    // Validate SSH configuration in development mode
    if (!this.validateSshConfig()) {
      const errorDetails = {
        domainName,
        phpVersion,
        vhostTemplate,
        siteUser,
        sshConfig: this.sshConfig,
      };

      logger.failure(
        "site",
        "SSH configuration validation failed for site creation",
        errorDetails
      );

      return Promise.reject({
        success: false,
        error: ResponseUtils.formatError({
          error: "Invalid SSH configuration for development mode",
          stderr: "Please check VPS_HOST and other SSH environment variables",
        }),
        command: "",
        exitCode: 1,
      });
    }

    const baseCreateSiteCommand = [
      "clpctl",
      "site:add:php",
      `--domainName=${domainName}`,
      `--phpVersion=${phpVersion}`,
      `--vhostTemplate="${vhostTemplate}"`,
      `--siteUser=${siteUser}`,
      `--siteUserPassword="${siteUserPassword}"`,
    ].join(" ");

    const siteDetails = {
      domainName,
      phpVersion,
      vhostTemplate,
      siteUser,
      command: baseCreateSiteCommand,
      executionMode: this.isDevelopment ? "SSH" : "Local",
    };

    if (this.isDevelopment && this.sshConfig.host) {
      try {
        const result = await this.executeSshCommand(baseCreateSiteCommand);

        logger.success(
          "site",
          `PHP site created successfully for domain: ${domainName}`,
          {
            domainName,
            phpVersion,
            vhostTemplate,
            siteUser,
            command: baseCreateSiteCommand,
            outputLength: result.output ? result.output.length : 0,
            executionTime: new Date().toISOString(),
          }
        );

        return {
          success: true,
          message: `Site created successfully for ${domainName}`,
          output: result.output || result,
          stderr: result.stderr,
          command: baseCreateSiteCommand,
          fullResult: result,
        };
      } catch (error) {
        logger.failure(
          "site",
          `PHP site creation failed for domain: ${domainName}`,
          {
            domainName,
            phpVersion,
            vhostTemplate,
            siteUser,
            error: error.error || error.message || error,
            command: baseCreateSiteCommand,
            stdout: error.stdout,
            stderr: error.stderr,
            exitCode: error.exitCode,
          }
        );

        // Parse error output for consistent error messages between dev/prod
        const output =
          error.fullOutput ||
          error.stdout + error.stderr ||
          error.error ||
          error.message ||
          error;
        const parsedError = this.parseErrorMessage(
          output,
          error.error || error.message || "Unknown error"
        );

        // Return more detailed error information
        return {
          success: false,
          message: `Site creation failed for ${domainName}`,
          error: parsedError,
          stdout: error.stdout,
          stderr: error.stderr,
          fullOutput: error.fullOutput,
          command: baseCreateSiteCommand,
          exitCode: error.exitCode,
        };
      }
    } else {
      return new Promise((resolve, reject) => {
        exec(
          baseCreateSiteCommand,
          { timeout: 120000 },
          (error, stdout, stderr) => {
            if (error) {
              const errorDetails = {
                domainName,
                phpVersion,
                vhostTemplate,
                siteUser,
                command: baseCreateSiteCommand,
                exitCode: error.code,
                stdout: stdout,
                stderr: stderr,
                errorMessage: error.message,
                fullOutput: stdout + stderr,
              };

              logger.failure(
                "site",
                `PHP site creation failed for domain: ${domainName}`,
                errorDetails
              );

              // Parse the error output to extract meaningful error messages
              const output = stdout + stderr;
              let parsedError = this.parseErrorMessage(output, error.message);

              reject({
                success: false,
                message: `Site creation failed for ${domainName}`,
                error: parsedError,
                command: baseCreateSiteCommand,
                exitCode: error.code,
                stdout: stdout,
                stderr: stderr,
                fullOutput: output,
              });
            } else {
              const successDetails = {
                domainName,
                phpVersion,
                vhostTemplate,
                siteUser,
                command: baseCreateSiteCommand,
                exitCode: 0,
                outputLength: stdout ? stdout.length : 0,
                executionTime: new Date().toISOString(),
              };

              logger.success(
                "site",
                `PHP site created successfully for domain: ${domainName}`,
                successDetails
              );

              const result = {
                success: true,
                message: `Site created successfully for ${domainName}`,
                output: stdout || "Command completed successfully",
                stderr: stderr,
                command: baseCreateSiteCommand,
                exitCode: 0,
              };
              resolve(result);
            }
          }
        );
      });
    }
  }

  /**
   * Create a database setup for a given domain
   * @param {string} domainName - The domain name for the site
   * @param {string} databaseName - The name of the database to create
   * @param {string} databaseUserName - The username for the database user
   * @param {string} databaseUserPassword - The password for the database user
   * @returns {Promise} - Promise that resolves with command output
   */
  async createDatabaseSetup(
    domainName,
    databaseName,
    databaseUserName,
    databaseUserPassword
  ) {
    // Validate SSH configuration in development mode
    if (!this.validateSshConfig()) {
      const errorDetails = {
        domainName,
        databaseName,
        databaseUserName,
        sshConfig: this.sshConfig,
      };

      logger.failure(
        "database",
        "SSH configuration validation failed for database creation",
        errorDetails
      );

      return Promise.reject({
        success: false,
        error: ResponseUtils.formatError({
          error: "Invalid SSH configuration for development mode",
          stderr: "Please check VPS_HOST and other SSH environment variables",
        }),
        command: "",
        exitCode: 1,
      });
    }

    const baseCreateDbCommand = [
      "clpctl",
      "db:add",
      `--domainName=${domainName}`,
      `--databaseName=${databaseName}`,
      `--databaseUserName=${databaseUserName}`,
      `--databaseUserPassword="${databaseUserPassword}"`,
    ].join(" ");

    const dbDetails = {
      domainName,
      databaseName,
      databaseUserName,
      command: baseCreateDbCommand,
      executionMode: this.isDevelopment ? "SSH" : "Local",
    };

    if (this.isDevelopment && this.sshConfig.host) {
      try {
        const result = await this.executeSshCommand(baseCreateDbCommand);

        logger.success(
          "database",
          `Database created successfully for domain: ${domainName}`,
          {
            domainName,
            databaseName,
            databaseUserName,
            command: baseCreateDbCommand,
            outputLength: result.output ? result.output.length : 0,
            executionTime: new Date().toISOString(),
          }
        );

        return {
          success: true,
          message: `Database created successfully for ${domainName}`,
          output: result.output || result,
          stderr: result.stderr,
          command: baseCreateDbCommand,
          fullResult: result,
        };
      } catch (error) {
        logger.failure(
          "database",
          `Database creation failed for domain: ${domainName}`,
          {
            domainName,
            databaseName,
            databaseUserName,
            error: error.error || error.message || error,
            command: baseCreateDbCommand,
            stdout: error.stdout,
            stderr: error.stderr,
            exitCode: error.exitCode,
          }
        );

        // Parse error output for consistent error messages between dev/prod
        const output =
          error.fullOutput ||
          error.stdout + error.stderr ||
          error.error ||
          error.message ||
          error;
        const parsedError = this.parseErrorMessage(
          output,
          error.error || error.message || "Unknown error"
        );

        // Return more detailed error information
        return {
          success: false,
          message: `Database creation failed for ${domainName}`,
          error: parsedError,
          stdout: error.stdout,
          stderr: error.stderr,
          fullOutput: error.fullOutput,
          command: baseCreateDbCommand,
          exitCode: error.exitCode,
        };
      }
    } else {
      return new Promise((resolve, reject) => {
        exec(
          baseCreateDbCommand,
          { timeout: 120000 },
          (error, stdout, stderr) => {
            if (error) {
              const errorDetails = {
                domainName,
                databaseName,
                databaseUserName,
                command: baseCreateDbCommand,
                exitCode: error.code,
                stdout: stdout,
                stderr: stderr,
                errorMessage: error.message,
                fullOutput: stdout + stderr,
              };

              logger.failure(
                "database",
                `Database creation failed for domain: ${domainName}`,
                errorDetails
              );

              // Parse the error output to extract meaningful error messages
              const output = stdout + stderr;
              let parsedError = this.parseErrorMessage(output, error.message);

              reject({
                success: false,
                message: `Database creation failed for ${domainName}`,
                error: parsedError,
                command: baseCreateDbCommand,
                exitCode: error.code,
                stdout: stdout,
                stderr: stderr,
                fullOutput: output,
              });
            } else {
              const successDetails = {
                domainName,
                databaseName,
                databaseUserName,
                command: baseCreateDbCommand,
                exitCode: 0,
                outputLength: stdout ? stdout.length : 0,
                executionTime: new Date().toISOString(),
              };

              logger.success(
                "database",
                `Database created successfully for domain: ${domainName}`,
                successDetails
              );

              const result = {
                success: true,
                message: `Database created successfully for ${domainName}`,
                output: stdout || "Command completed successfully",
                stderr: stderr,
                command: baseCreateDbCommand,
                exitCode: 0,
              };
              resolve(result);
            }
          }
        );
      });
    }
  }

  /**
   * Copy SSH keys from root to the specified site user
   * @param {string} siteUser - The user to copy SSH keys to
   * @returns {Promise} - Promise that resolves with command output
   */
  async copySshKeysToUser(siteUser) {
    // Validate SSH configuration in development mode
    if (!this.validateSshConfig()) {
      return Promise.reject({
        success: false,
        error: ResponseUtils.formatError({
          error: "Invalid SSH configuration for development mode",
          stderr: "Please check VPS_HOST and other SSH environment variables",
        }),
        command: "",
        exitCode: 1,
      });
    }

    // Create SSH directory and copy keys from root to site user
    const commands = [
      `sudo mkdir -p /home/${siteUser}/.ssh`,
      `sudo cp /root/.ssh/id_ed25519 /home/${siteUser}/.ssh/id_ed25519`,
      `sudo cp /root/.ssh/id_ed25519.pub /home/${siteUser}/.ssh/id_ed25519.pub`,
      `sudo chown -R ${siteUser}:${siteUser} /home/${siteUser}/.ssh`,
      `sudo chmod 700 /home/${siteUser}/.ssh`,
      `sudo chmod 600 /home/${siteUser}/.ssh/id_ed25519`,
      `sudo chmod 644 /home/${siteUser}/.ssh/id_ed25519.pub`,
    ];

    const baseCombinedCommand = commands.join(" && ");

    if (this.isDevelopment && this.sshConfig.host) {
      try {
        const result = await this.executeSshCommand(baseCombinedCommand);
        logger.info(`SSH keys successfully copied to user ${siteUser}`);
        return {
          success: true,
          message: `SSH keys copied to user ${siteUser}`,
          output: result.output || result,
          stderr: result.stderr,
          fullResult: result,
        };
      } catch (error) {
        logger.error(`SSH key copy failed for user ${siteUser}:`, error);
        return {
          success: false,
          message: `SSH key copy failed for user ${siteUser}`,
          error: error.error || error.message || error,
          stdout: error.stdout,
          stderr: error.stderr,
          fullOutput: error.fullOutput,
          exitCode: error.exitCode,
        };
      }
    } else {
      // Local execution for production
      return new Promise((resolve, reject) => {
        exec(
          baseCombinedCommand,
          { timeout: 30000 },
          (error, stdout, stderr) => {
            if (error) {
              logger.error(`SSH key copy failed for user ${siteUser}:`, error);
              reject({
                success: false,
                message: `SSH key copy failed for user ${siteUser}`,
                error: ResponseUtils.formatError({
                  error: error.message,
                  stderr,
                }),
                command: baseCombinedCommand,
                exitCode: error.code,
                stdout: stdout,
                stderr: stderr,
                fullOutput: stdout + stderr,
              });
            } else {
              logger.info(`SSH keys successfully copied to user ${siteUser}`);
              const result = {
                success: true,
                message: `SSH keys copied to user ${siteUser}`,
                output: stdout || "Command completed successfully",
                stderr: stderr,
                command: baseCombinedCommand,
                exitCode: 0,
              };
              resolve(result);
            }
          }
        );
      });
    }
  }

  /**
   * Clone a repository into the specified domain's htdocs directory
   * @param {string} domainName - The domain name for the site
   * @param {string} repositoryUrl - The URL of the repository to clone (ssh clone only)
   * @param {string} siteUser - The user under which to run the command
   * @returns {Promise} - Promise that resolves with command output
   */
  extractGitUrl(url) {
    return url.split(" ").pop();
  }
  extractBranch(url) {
    const parts = url.split(" ");
    const bIndex = parts.indexOf("-b");
    if (bIndex !== -1 && bIndex + 1 < parts.length) {
      return parts[bIndex + 1];
    }
    return null;
  }
  async cloneRepository(domainName, repositoryUrl, siteUser) {
    // Validate SSH configuration in development mode
    if (!this.validateSshConfig()) {
      return Promise.reject({
        success: false,
        error: ResponseUtils.formatError({
          error: "Invalid SSH configuration for development mode",
          stderr: "Please check VPS_HOST and other SSH environment variables",
        }),
        command: "",
        exitCode: 1,
      });
    }
    const repoUrl = this.extractGitUrl(repositoryUrl);
    const isBranch = repositoryUrl.includes("-b") || false;
    const branch = this.extractBranch(repositoryUrl) || "";

    const sshCommand =
      "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null";
    const sitePath = `/home/${siteUser}/htdocs/${domainName}`;
    const deleteCommand = `rm -rf ${sitePath}/* ${sitePath}/.* 2>/dev/null || true`;
    const baseCommand = `su - ${siteUser} -c 'cd "${sitePath}" && ${deleteCommand} && GIT_SSH_COMMAND="${sshCommand}" git clone${isBranch ? ` -b ${branch} --single-branch` : ""
      } "${repoUrl}" .'`;

    if (this.isDevelopment && this.sshConfig.host) {
      try {
        const result = await this.executeSshCommand(baseCommand);
        logger.info(`Repository cloned successfully for ${domainName}`);
        return {
          success: true,
          message: `Repository cloned successfully to ${domainName}`,
          output: result.output || result,
          stderr: result.stderr,
          command: baseCommand,
          fullResult: result,
        };
      } catch (error) {
        logger.error(`Repository clone failed for ${domainName}:`, error);
        return {
          success: false,
          message: `Repository clone failed for ${domainName}`,
          error: error.error || error.message || error,
          stdout: error.stdout,
          stderr: error.stderr,
          fullOutput: error.fullOutput,
          command: baseCommand,
          exitCode: error.exitCode,
        };
      }
    } else {
      // Local execution for production
      return new Promise((resolve, reject) => {
        exec(baseCommand, { timeout: 120000 }, (error, stdout, stderr) => {
          if (error) {
            logger.error(`Repository clone failed for ${domainName}:`, error);
            reject({
              success: false,
              message: `Repository clone failed for ${domainName}`,
              error: ResponseUtils.formatError({
                error: error.message,
                stderr,
              }),
              command: baseCommand,
              exitCode: error.code,
              stdout: stdout,
              stderr: stderr,
              fullOutput: stdout + stderr,
            });
          } else {
            logger.info(
              `Repository cloned successfully for ${domainName}`,
              stdout + stderr
            );
            const result = {
              success: true,
              message: `Repository cloned successfully to ${domainName}`,
              output: stdout || "Command completed successfully",
              stderr: stderr,
              command: baseCommand,
              exitCode: 0,
            };
            resolve(result);
          }
        });
      });
    }
  }

  /**
   * Configure Laravel .env file with database and app settings
   * @param {string} domainName - The domain name for the site
   * @param {string} siteUser - The site user
   * @param {Object} envSettings - Environment settings object
   * @returns {Promise} - Promise that resolves with command output
   */
  async configureLaravelEnv(domainName, siteUser, envSettings) {
    // Validate SSH configuration in development mode
    if (!this.validateSshConfig()) {
      return Promise.reject({
        success: false,
        error: ResponseUtils.formatError({
          error: "Invalid SSH configuration for development mode",
          stderr: "Please check VPS_HOST and other SSH environment variables",
        }),
        command: "",
        exitCode: 1,
      });
    }

    const {
      dbHost = "localhost",
      dbDatabase,
      dbUsername,
      dbPassword,
      appUrl = `https://${domainName}`,
      appEnv = "production",
      appDebug = "false",
    } = envSettings;

    const baseCommand = `sudo -u ${siteUser} bash -c '
cd /home/${siteUser}/htdocs/${domainName} &&
cp .env.example .env &&
sed -i "s/^APP_ENV=.*/APP_ENV=${appEnv}/" .env &&
sed -i "s/^APP_DEBUG=.*/APP_DEBUG=${appDebug}/" .env &&
sed -i "s|^APP_URL=.*|APP_URL=${appUrl}|" .env &&
sed -i "s|^APP_NODE_URL=.*|APP_NODE_URL=${API_NODE_URL}|" .env &&
sed -i "s/^DB_HOST=.*/DB_HOST=${dbHost}/" .env &&
sed -i "s/^DB_DATABASE=.*/DB_DATABASE=${dbDatabase}/" .env &&
sed -i "s/^DB_USERNAME=.*/DB_USERNAME=${dbUsername}/" .env &&
sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=${dbPassword}/" .env'`;

    if (this.isDevelopment && this.sshConfig.host) {
      try {
        const result = await this.executeSshCommand(baseCommand);
        logger.info(`Laravel .env configured successfully for ${domainName}`);
        return {
          success: true,
          message: `Laravel .env configured successfully for ${domainName}`,
          output: result.output || result,
          stderr: result.stderr,
          command: baseCommand,
          fullResult: result,
        };
      } catch (error) {
        logger.error(
          `Laravel .env configuration failed for ${domainName}:`,
          error
        );
        return {
          success: false,
          message: `Laravel .env configuration failed for ${domainName}`,
          error: error.error || error.message || error,
          stdout: error.stdout,
          stderr: error.stderr,
          fullOutput: error.fullOutput,
          command: baseCommand,
          exitCode: error.exitCode,
        };
      }
    } else {
      // Local execution for production
      return new Promise((resolve, reject) => {
        exec(baseCommand, { timeout: 60000 }, (error, stdout, stderr) => {
          if (error) {
            logger.error(
              `Laravel .env configuration failed for ${domainName}:`,
              error
            );
            reject({
              success: false,
              message: `Laravel .env configuration failed for ${domainName}`,
              error: ResponseUtils.formatError({
                error: error.message,
                stderr,
              }),
              command: baseCommand,
              exitCode: error.code,
              stdout: stdout,
              stderr: stderr,
              fullOutput: stdout + stderr,
            });
          } else {
            logger.info(
              `Laravel .env configured successfully for ${domainName}`
            );
            const result = {
              success: true,
              message: `Laravel .env configured successfully for ${domainName}`,
              output: stdout || "Command completed successfully",
              stderr: stderr,
              command: baseCommand,
              exitCode: 0,
            };
            resolve(result);
          }
        });
      });
    }
  }

  /**
   * Run Laravel post-setup commands (migrations, cache, etc.)
   * @param {string} domainName - The domain name for the site
   * @param {string} siteUser - The site user
   * @param {Object} options - Options for Laravel setup
   * @returns {Promise} - Promise that resolves with command output
   */
  async runLaravelSetup(domainName, siteUser, options = {}) {
    // Validate SSH configuration in development mode
    if (!this.validateSshConfig()) {
      return Promise.reject({
        success: false,
        error: ResponseUtils.formatError({
          error: "Invalid SSH configuration for development mode",
          stderr: "Please check VPS_HOST and other SSH environment variables",
        }),
        command: "",
        exitCode: 1,
      });
    }

    const {
      runMigrations = true,
      runSeeders = true,
      optimizeCache = true,
      installComposer = true,
    } = options;

    const commands = [];

    // Base command prefix
    const baseCommand = `sudo -u ${siteUser} bash -c 'cd /home/${siteUser}/htdocs/${domainName}`;

    // Install composer dependencies
    if (installComposer) {
      commands.push(
        `${baseCommand} && composer install --optimize-autoloader --no-dev && php artisan key:generate --force'`
      );
    }

    // Run migrations
    if (runMigrations) {
      commands.push(`${baseCommand} && php artisan migrate --force'`);
    }

    // Run seeders
    if (runSeeders) {
      commands.push(`${baseCommand} && php artisan db:seed --force'`);
    }

    const baseFullCommand = commands.join(" && ");

    // Create a version of the command without composer install for logging
    const commandsForLogging = [];

    // Skip composer install in logging
    if (runMigrations) {
      commandsForLogging.push(`${baseCommand} && php artisan migrate --force'`);
    }

    if (runSeeders) {
      commandsForLogging.push(`${baseCommand} && php artisan db:seed --force'`);
    }

    commandsForLogging.push(`${baseCommand} && php artisan optimize:clear'`);

    const commandForLogging =
      commandsForLogging.length > 0
        ? commandsForLogging.join(" && ")
        : "Laravel setup commands (excluding composer install)";

    if (this.isDevelopment && this.sshConfig.host) {
      try {
        const result = await this.executeSshCommand(baseFullCommand);
        logger.info(
          `Laravel setup completed successfully for ${domainName}`,
          result
        );
        return {
          success: true,
          message: `Laravel setup completed successfully for ${domainName}`,
          output: result.output || result,
          stderr: result.stderr,
          command: commandForLogging,
          fullResult: result,
        };
      } catch (error) {
        logger.error(`Laravel setup commands failed for ${domainName}:`, error);
        return {
          success: false,
          message: `Laravel setup commands failed for ${domainName}`,
          error: error.error || error.message || error,
          stdout: error.stdout,
          stderr: error.stderr,
          fullOutput: error.fullOutput,
          command: commandForLogging,
          exitCode: error.exitCode,
        };
      }
    } else {
      // Local execution for production
      return new Promise((resolve, reject) => {
        exec(baseFullCommand, { timeout: 180000 }, (error, stdout, stderr) => {
          if (error) {
            logger.error(
              `Laravel setup commands failed for ${domainName}:`,
              error
            );
            reject({
              success: false,
              message: `Laravel setup commands failed for ${domainName}`,
              error: ResponseUtils.formatError({
                error: error.message,
                stderr,
              }),
              command: commandForLogging,
              exitCode: error.code,
              stdout: stdout,
              stderr: stderr,
              fullOutput: stdout + stderr,
            });
          } else {
            const result = {
              success: true,
              message: `Laravel setup completed successfully for ${domainName}`,
              output: stdout || "Command completed successfully",
              stderr: stderr,
              command: commandForLogging,
              exitCode: 0,
            };
            logger.info(
              `Laravel setup completed successfully for ${domainName}`,
              result
            );
            resolve(result);
          }
        });
      });
    }
  }
  async safeNginxRestart() {
    const commands = [
      // Fail fast di bash
      "set -euo pipefail",

      // 1) Validate config
      "nginx -t",

      // 2) Pastikan pidfile ada
      '[ -f /run/nginx.pid ] || { echo \"pidfile /run/nginx.pid tidak ditemukan\"; exit 1; }',

      // 3) Graceful upgrade: spawn master baru
      "kill -USR2 \"$(cat /run/nginx.pid)\"",

      // 4) Stop worker lama (kalau oldbin ada)
      "[ -f /run/nginx.pid.oldbin ] && kill -WINCH \"$(cat /run/nginx.pid.oldbin)\" || true",

      // 5) Napas sebentar
      "sleep 1",

      // 6) Health-check ke service target (HTTPS langsung, bukan Nginx)
      //    Sukses jika 2xx/3xx; gagal selain itu
      "code=$(curl -sS --max-time 8 -o /dev/null -w \"%{http_code}\" https://mikronode.bayarinternet.com/health); case \"$code\" in 2*|3*) echo \"health-check OK: $code\" ;; *) echo \"health-check gagal: $code\"; exit 1 ;; esac",

      // 7) Shutdown old master (kalau ada)
      "[ -f /run/nginx.pid.oldbin ] && kill -QUIT \"$(cat /run/nginx.pid.oldbin)\" || true",

      // 8) FINAL CLEANUP — shutdown & hapus pidfile oldbin
      `OLD="$(cat /run/nginx.pid.oldbin 2>/dev/null || echo '')";
if [ -n "$OLD" ] && ps -p "$OLD" > /dev/null 2>&1; then
  kill -QUIT "$OLD" || true
  sleep 2
  ps -p "$OLD" > /dev/null 2>&1 || { rm -f /run/nginx.pid.oldbin; echo "oldbin cleaned"; }
else
  rm -f /run/nginx.pid.oldbin 2>/dev/null || true
fi`,
    ];

    const fullCommand = commands.join(" && ");

    return new Promise((resolve, reject) => {
      exec(fullCommand, { timeout: 180000 }, (error, stdout, stderr) => {
        if (error) {
          const formattedError = ResponseUtils.formatError({
            error: error.message,
            stderr,
          });

          const err = new Error(`Nginx safe restart commands failed: ${formattedError}`);
          err.command = fullCommand;
          err.exitCode = error.code;
          err.stdout = stdout;
          err.stderr = stderr;
          err.fullOutput = stdout + stderr;

          logger.error(`Nginx safe restart commands failed`, {
            command: err.command,
            exitCode: err.exitCode,
            stdout: err.stdout,
            stderr: err.stderr,
          });
          reject(err);
          return;
        }

        const result = {
          success: true,
          message: `Nginx safe restart completed successfully`,
          output: stdout || "Command completed successfully",
          stderr,
          command: fullCommand,
          exitCode: 0,
        };

        logger.info(`Nginx safe restart completed successfully`, result);
        resolve(result);
      });
    });
  }
}

module.exports = new CloudPanelService();
