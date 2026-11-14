import { promises as fs } from "node:fs";
import { AshError } from "../errors.js";

export const SANDBOX_READY = "ASH_SANDBOX_READY\n";

/** No host-shell fallback: namespace setup must succeed before the command starts. */
export async function verificationSandbox(
  workspace: string,
  command: string,
): Promise<{ executable: string; args: string[] }> {
  if (process.platform !== "linux")
    throw new AshError(
      "UNSAFE_OPERATION",
      "Executable verification requires Linux with Bubblewrap and user namespaces. No command was run.",
    );
  const executable = "/usr/bin/bwrap";
  await fs.access(executable).catch(() => {
    throw new AshError(
      "UNSAFE_OPERATION",
      "Install Bubblewrap (bwrap) to enable isolated verification. No command was run.",
    );
  });
  const args = [
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "--die-with-parent",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/usr",
    "/usr",
  ];
  for (const location of ["/bin", "/lib", "/lib64"]) {
    const stat = await fs.lstat(location).catch(() => null);
    if (stat?.isSymbolicLink()) args.push("--symlink", await fs.readlink(location), location);
    else if (stat?.isDirectory()) args.push("--ro-bind", location, location);
  }
  // Only installed runtime binaries/libraries are shared. Hide optional local configuration.
  for (const location of ["/usr/local/etc", "/usr/etc"])
    if ((await fs.stat(location).catch(() => null))?.isDirectory()) args.push("--tmpfs", location);
  args.push(
    "--dir",
    "/etc",
    "--dir",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/runtime",
    "--ro-bind",
    process.execPath,
    "/runtime/node",
    "--dir",
    "/tmp/home",
    "--ro-bind",
    workspace,
    "/workspace",
    "--chdir",
    "/workspace",
    "--clearenv",
    "--setenv",
    "PATH",
    "/runtime:/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/tmp/home",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "TERM",
    "dumb",
    "--setenv",
    "NO_COLOR",
    "1",
    "--setenv",
    "CI",
    "1",
    "--setenv",
    "ASH_VERIFICATION",
    "1",
    "--",
    "/bin/sh",
    "-c",
    'printf "ASH_SANDBOX_READY\\n"; exec /bin/sh -c "$1"',
    "ash-verification",
    command,
  );
  return { executable, args };
}
