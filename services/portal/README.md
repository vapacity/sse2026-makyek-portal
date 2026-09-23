## Deploy

1. copy `config-template.yaml` to `config.yaml`
2. change sensitive info. in config.yaml
3. run the following code in terminal.

```bash
npm dep-install
npm build:ui
npm build:server
npm start
```

## Add User

```bash
npm run cli -- DI.models.User.createUserAsync {username} {password} {student_id} {real_name} {role}
```

Roles can be: `admin` / `mod` / `student`

## Reset User Password

```bash
npm run cli -- DI.models.User.setUserPasswordAsync {username} {new_password}
```

## Update User Role

```bash
npm run cli -- DI.models.User.setUserRoleAsync {username} {new_role}
```
