# Reversi Judge Daemon

## Usage

```bash
npm run build
pm2 start pm2-compile.yaml
pm2 start pm2-judge.yaml
```

## Show Logs

```bash
pm2 logs compile
```

## Prerequisites

- Git

- Node.js >= 6.0

- TDM-GCC

- PM2

    ```bash
    npm install -g pm2 --registry=https://registry.npm.taobao.org --disturl=https://npm.taobao.org/dist
    ```

## Windows Sandbox

Everything is running inside a sandbox in low IL. You need to set IL of the runtime directory so that it can be read or written by sandboxed applications.

```batch
icacls "DIRECTORY_OF_RUNTIME" /setintegritylevel (OI)(CI)low /t /c
```

## Compiler

The compiler requires GCC installed and in path. On Windows, TDM-GCC x86 is recommended.

### Windows & Sandbox

On Windows, Mingw-GCC uses `%USERPROFILE%\AppData\Local\Temp`, which is not accessible by default in low IL when it is spawned by the sandbox.

A workaround:

```batch
icacls "%USERPROFILE%\AppData\Local\Temp" /setintegritylevel (OI)(CI)low /t /c
```
