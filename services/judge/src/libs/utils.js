import child_process from 'child_process';

const utils = {};

utils.log = (type, data) => {
  console.log(JSON.stringify({ at: Date.now(), type, data }));
};

utils.spawnSandbox = (command, args, sandboxBin, sandboxOptions) => {
  let spawnCommand, spawnArgs;
  if (sandboxBin) {
    spawnCommand = sandboxBin;
    spawnArgs = [];
    spawnArgs.push('--use-desktop');
    spawnArgs.push('--use-logon');
    spawnArgs.push('--active-process', 1);
    spawnArgs.push('--memory', sandboxOptions.maxMemory);
    if (sandboxOptions.affinity) {
      spawnArgs.push('--affinity', 1 << (sandboxOptions.affinity - 1));
    }
    spawnArgs.push(command, ...args);
  } else {
    spawnCommand = command;
    spawnArgs = args;
    if (process.platform === 'linux') {
      spawnCommand = '/usr/bin/prlimit';
      spawnArgs = [`--as=${sandboxOptions.maxMemory}`, '--nproc=0',
        `--cpu=${Math.ceil((sandboxOptions.maxTime || 90000) / 1000) + 10}`,
        '--', command, ...args];
    }
  }
  return child_process.spawn(spawnCommand, spawnArgs, {
    stdio: 'pipe',
    detached: process.platform !== 'win32',
  });
};

utils.terminateProcess = (child) => {
  if (child.stdout) {
    child.stdout.destroy();
  }
  if (child.stderr) {
    child.stderr.destroy();
  }
  try {
    if (process.platform === 'win32') {
      // kill process tree
      child_process.execSync(`taskkill /pid ${child.pid} /T /F`);
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch (ignore) {
    // ignore
  }
};

export default utils;
