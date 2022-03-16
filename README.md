# action-verified-commit
GitHub action to make commits with bots and get the verified check.

## Inputs
|Name|Description|Default|
|---|---|---|
|path|The path of the git repository|`.`|
|branch|The branch to commit to. If not specified, it will use the branch checked out|`null`|
|token|The token to use when communicating with the REST API to make the commits|`${{ github.token }}`|
|commit-message|The message to use when commit|`Automated commit using the action alvarezfr/action-verified-commit`|
