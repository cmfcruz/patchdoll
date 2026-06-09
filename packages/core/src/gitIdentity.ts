import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);

export interface GitAuthorIdentityOptions {
  env?: NodeJS.ProcessEnv;
  gitBin?: string;
  ghBin?: string;
  cwd?: string;
  execFile?: ExecFile;
}

type ExecFile = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string }
) => Promise<{ stdout: string; stderr: string }>;

export async function ensureGitAuthorIdentity({
  env = process.env,
  gitBin = "git",
  ghBin = "gh",
  cwd,
  execFile = defaultExecFile
}: GitAuthorIdentityOptions = {}): Promise<void> {
  const gitEnv = { ...env };
  const configuredName = nonEmptyString(process.env.PATCHDOLL_GIT_USER_NAME);
  const configuredEmail = nonEmptyString(process.env.PATCHDOLL_GIT_USER_EMAIL);

  if (configuredName || configuredEmail) {
    if (!configuredName || !configuredEmail) {
      throw new Error(
        "PATCHDOLL_GIT_USER_NAME and PATCHDOLL_GIT_USER_EMAIL must be configured together"
      );
    }
    await setGitIdentity(execFile, gitBin, gitEnv, cwd, configuredName, configuredEmail);
    return;
  }

  const existingName = await gitConfigValue(execFile, gitBin, gitEnv, cwd, "user.name");
  const existingEmail = await gitConfigValue(execFile, gitBin, gitEnv, cwd, "user.email");
  if (existingName && existingEmail) {
    return;
  }

  if (!gitEnv.GH_TOKEN && !gitEnv.GITHUB_TOKEN) {
    return;
  }

  const login = await ghLogin(execFile, ghBin, gitEnv, cwd);
  const email = await githubNoreplyEmail(execFile, ghBin, gitEnv, cwd, login);
  await setGitIdentity(execFile, gitBin, gitEnv, cwd, login, email);
}

async function setGitIdentity(
  execFile: ExecFile,
  gitBin: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  name: string,
  email: string
): Promise<void> {
  await execFile(gitBin, ["config", "--global", "--replace-all", "user.name", name], {
    env,
    cwd
  });
  await execFile(gitBin, ["config", "--global", "--replace-all", "user.email", email], {
    env,
    cwd
  });
}

async function gitConfigValue(
  execFile: ExecFile,
  gitBin: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  key: string
): Promise<string | undefined> {
  try {
    const { stdout } = await execFile(gitBin, ["config", "--global", "--get", key], {
      env,
      cwd
    });
    return nonEmptyString(stdout);
  } catch {
    return undefined;
  }
}

async function ghLogin(
  execFile: ExecFile,
  ghBin: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined
): Promise<string> {
  const { stdout, stderr } = await execFile(
    ghBin,
    ["auth", "status", "--hostname", "github.com"],
    { env, cwd }
  );
  const authStatus = `${stdout}\n${stderr}`;
  const match = authStatus.match(/Logged in to github\.com as ([^\s]+)/);
  const login = nonEmptyString(match?.[1]);
  if (!login) {
    throw new Error("Unable to infer git author from gh auth status");
  }
  return login;
}

async function githubNoreplyEmail(
  execFile: ExecFile,
  ghBin: string,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  login: string
): Promise<string> {
  if (!login.endsWith("[bot]")) {
    return `${login}@users.noreply.github.com`;
  }

  const { stdout } = await execFile(
    ghBin,
    ["api", `users/${encodeURIComponent(login)}`, "--jq", ".id"],
    { env, cwd }
  );
  const id = nonEmptyString(stdout);
  if (!id) {
    throw new Error(`Unable to infer GitHub bot user id for ${login}`);
  }
  return `${id}+${login}@users.noreply.github.com`;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    env: options.env,
    cwd: options.cwd,
    encoding: "utf8"
  });
  return { stdout, stderr };
}
