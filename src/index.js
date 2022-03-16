import * as core from '@actions/core'
import * as github from '@actions/github'
import simpleGit from 'simple-git'
import path from 'path'
import fs from 'fs'

const CONTEXT = {
  TASK: {}
}

async function identifyRepository () {
  const branch = await CONTEXT.git.revparse(['--abbrev-ref', 'HEAD'])
  const sha = await CONTEXT.git.revparse(['HEAD']) // sha of the last commit
  const originRemote = (await CONTEXT.git.remote(['get-url', 'origin']))

  const [owner, repo] = originRemote
    .trimEnd()
    .replace(/\.git$/, '')
    .split('/')
    .slice(3, 5)

  core.debug('Repository:')
  core.debug(`  repo: ${repo}`)
  core.debug(`  owner: ${owner}`)
  core.debug(`  branch: ${branch}`)
  core.debug(`  lastCommitSha: ${sha}`)

  return { repo, owner, branch, sha }
}

// Prints git status of the repository using core.debug
function debugGitStatus (gitStatus) {
  core.debug('git status:')
  for (const [key, value] of Object.entries(gitStatus)) {
    if (key !== 'files' && typeof value === 'object' && value && value.length > 0) {
      core.debug(`  ${key}: ${JSON.stringify(value)}`)
    }
  }
}

async function createRemoteBranch (branch) {
  // Creates the PR branch if needed and if doesn't exists
  const octokit = CONTEXT.octokit
  const { owner, repo, sha } = CONTEXT.REPO

  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      sha,
      ref: `refs/heads/${branch}`
    })

    core.debug(`Created new branch ${branch}`)
  } catch (error) {
    // If the branch exists ignores the error
    if (error instanceof Error && error.message !== 'Reference already exists') {
      throw error
    }
    core.debug(`Branch ${branch} already exists`)
  }
}

// A wrapper for running all the flow to replicate a local commit in GitHub using the API
async function createGithubVerifiedCommit () {
  // --- Start local functions ---

  // Returns a git tree parsed for the specified commit sha
  async function getTree (commitSha) {
    core.debug(`Getting tree for commit ${commitSha}`)
    const output = (await CONTEXT.git.raw('ls-tree', '-r', '--full-tree', commitSha)).trimEnd()

    const tree = []
    for (const treeObject of output.split('\n')) {
      const [mode, type, sha] = treeObject.split(/\s/)
      const file = treeObject.split('\t')[1]

      const treeEntry = {
        mode,
        type,
        sha,
        path: file
      }

      tree.push(treeEntry)
    }

    return tree
  }

  async function getBlobBase64Content (file) {
    const fileRelativePath = path.join(CONTEXT.PATH, file)
    const fileContent = await fs.promises.readFile(fileRelativePath)

    return fileContent.toString('base64')
  }

  // Creates the blob objects in GitHub for the files that are not in the previous commit only
  async function createGithubBlobs (commitSha) {
    core.debug('Creating missing blobs on GitHub')
    const [previousTree, tree] = await Promise.all([getTree(`${commitSha}~1`), getTree(commitSha)])
    const promisesGithubCreateBlobs = []

    for (const treeEntry of tree) {
      // If the current treeEntry are in the previous tree, that means that the blob is uploaded and it doesn't need to be uploaded to GitHub again.
      if (previousTree.findIndex((entry) => entry.sha === treeEntry.sha) !== -1) {
        continue
      }

      const base64Content = await getBlobBase64Content(treeEntry.path)

      // Creates the blob. We don't need to store the response because the local sha is the same and we can use it to reference the blob
      const githubCreateBlobRequest = CONTEXT.octokit.rest.git.createBlob({
        owner: CONTEXT.REPO.owner,
        repo: CONTEXT.REPO.repo,
        content: base64Content,
        encoding: 'base64'
      })

      core.debug(`Creating blob in GitHub for file '${treeEntry.path}'`)
      promisesGithubCreateBlobs.push(githubCreateBlobRequest)
    }

    // Wait for all the file uploads to be completed
    await Promise.all(promisesGithubCreateBlobs)
    core.debug('GitHub blobs created')
  }

  async function createGithubTreeAndCommit (tree, commitMessage) {
    core.debug('Creating a GitHub tree')
    let treeSha
    try {
      const request = await CONTEXT.octokit.rest.git.createTree({
        owner: CONTEXT.REPO.owner,
        repo: CONTEXT.REPO.repo,
        tree
      })
      treeSha = request.data.sha
    } catch (error) {
      error.message = `Cannot create a new GitHub Tree: ${error.message}`
      throw error
    }

    core.debug('Creating a commit for the GitHub tree')
    const request = await CONTEXT.octokit.rest.git.createCommit({
      owner: CONTEXT.REPO.owner,
      repo: CONTEXT.REPO.repo,
      message: commitMessage,
      parents: [CONTEXT.TASK.lastCommitSha],
      tree: treeSha
    })
    CONTEXT.TASK.lastCommitSha = request.data.sha
  }

  async function updateGithubRef () {
    core.debug(`Updating branch ${CONTEXT.TASK.branch} ref`)
    await await CONTEXT.octokit.rest.git.updateRef({
      owner: CONTEXT.REPO.owner,
      repo: CONTEXT.REPO.repo,
      ref: `heads/${CONTEXT.TASK.branch}`,
      sha: CONTEXT.TASK.lastCommitSha,
      force: true
    })
  }

  // --- End local functions ---

  const desiredTree = await getTree(CONTEXT.TASK.localCommit)

  // Creates the new blob files in github
  await createGithubBlobs(CONTEXT.TASK.localCommit)

  await createGithubTreeAndCommit(desiredTree, CONTEXT.INPUTS.commitMessage)

  await updateGithubRef()

  core.debug('Commit using GitHub API completed')
}

async function run () {
  console.info('Action started')

  // Get inputs
  const inputs = {
    token: core.getInput('token', { required: true }),
    path: core.getInput('path', { required: true }),
    branch: core.getInput('branch', { required: false }),
    commitMessage: core.getInput('commit-message', { required: true })
  }
  core.setSecret(inputs.token)

  CONTEXT.INPUTS = inputs
  CONTEXT.PATH = path.resolve(inputs.path)

  // Init git
  CONTEXT.git = simpleGit(CONTEXT.PATH)
  CONTEXT.git.addConfig('user.name', 'local_user', false, 'local')
  CONTEXT.git.addConfig('user.email', 'local_user@example.com', false, 'local')

  CONTEXT.REPO = await identifyRepository()
  CONTEXT.TASK.lastCommitSha = CONTEXT.REPO.sha
  const status = await CONTEXT.git.status()

  CONTEXT.TASK.branch = inputs.branch !== '' ? inputs.branch : CONTEXT.REPO.branch

  debugGitStatus(status)

  if (status.isClean()) {
    core.info(`The git repository ${CONTEXT.REPO.owner}/${CONTEXT.REPO.repo} with path ${CONTEXT.PATH} has not changes. Exiting action.`)
    return
  }

  CONTEXT.octokit = github.getOctokit(inputs.token)

  const useRemoteBranch = CONTEXT.TASK.branch !== CONTEXT.REPO.branch

  if (useRemoteBranch) {
    await createRemoteBranch(CONTEXT.TASK.branch)
  }

  // Helper local commit used to generate the remote commit
  core.debug('Creating local commit with with the changes as helper')
  const localCommit = await CONTEXT.git.add('./*').commit('local commit')
  CONTEXT.TASK.localCommit = localCommit.commit.replace('HEAD ', '') // 'HEAD ' founded in some cases, maybe a bug in simple-git?
  core.debug(`Local commit created: ${JSON.stringify(localCommit)}`)

  await createGithubVerifiedCommit()

  console.info('Action completed')
}

(async () => {
  try {
    await run()
  } catch (error) {
    core.setFailed(`Action failed with error ${error}`)
  }
})()
