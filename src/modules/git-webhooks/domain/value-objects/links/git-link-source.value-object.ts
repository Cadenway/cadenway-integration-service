/**
 * Where the task key was found when the link was created: the branch name or source branch,
 * the request title, its description or a commit message (GitLinkSource, Integration contract).
 */
export type GitLinkSource = 'branch' | 'title' | 'description' | 'commit';
