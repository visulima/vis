//! Where `get_main_worktree_root` anchors the shared cache for each way git lays out a repository.
//!
//! The anchor is the top level of the main worktree. These tests build real repositories with `git`:
//! a plain checkout, a submodule and a `--separate-git-dir` checkout are their own anchor (`None`); a linked
//! worktree anchors at the checkout it was added from, except where git does not record that checkout (a
//! linked worktree of a `--separate-git-dir` checkout), which keeps its own anchor.
//!
//! Unix only, like the other worktree tests: the CI leg that runs this crate on Windows filters to the
//! concurrent runner.

#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use task_runner_core::{get_main_worktree_root, reset_worktree_cache};

struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        let path =
            fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("tr-anchor-{}-{tag}", std::process::id()));

        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        reset_worktree_cache();

        Self(path)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(["-c", "protocol.file.allow=always", "-c", "user.name=t", "-c", "user.email=t@example.com"])
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");

    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

/// A repository with one commit at `path`; `extra` goes to `git init`.
fn init(path: &Path, extra: &[&str]) {
    fs::create_dir_all(path).unwrap();
    git(path, &[&["init", "-q", "--initial-branch=main"], extra].concat());
    fs::write(path.join("README.md"), "x\n").unwrap();
    git(path, &["add", "README.md"]);
    git(path, &["commit", "-q", "-m", "init"]);
}

/// `<scratch>/repo` with its git dir at `<scratch>/elsewhere/repo.git`.
fn init_separate(scratch: &Scratch) {
    fs::create_dir_all(scratch.path("elsewhere")).unwrap();
    init(&scratch.path("repo"), &["--separate-git-dir", scratch.path("elsewhere/repo.git").to_str().unwrap()]);
}

fn anchor(path: &Path) -> Option<PathBuf> {
    get_main_worktree_root(path.to_str().unwrap()).unwrap().map(PathBuf::from)
}

#[test]
fn a_plain_checkout_is_its_own_anchor() {
    let scratch = Scratch::new("plain");

    init(&scratch.path("repo"), &[]);

    assert_eq!(anchor(&scratch.path("repo")), None);
}

#[test]
fn a_directory_that_is_not_a_repository_has_no_anchor() {
    let scratch = Scratch::new("none");

    fs::create_dir_all(scratch.path("plain")).unwrap();

    assert_eq!(anchor(&scratch.path("plain")), None);
}

#[test]
fn a_linked_worktree_anchors_at_the_main_checkout() {
    let scratch = Scratch::new("linked");

    init(&scratch.path("main"), &[]);
    git(&scratch.path("main"), &["worktree", "add", "-q", "-b", "feat", scratch.path("feat").to_str().unwrap()]);

    assert_eq!(anchor(&scratch.path("feat")), Some(scratch.path("main")));
}

#[test]
fn a_submodule_is_its_own_anchor_not_the_superprojects_git_modules() {
    let scratch = Scratch::new("submodule");

    init(&scratch.path("lib"), &[]);
    init(&scratch.path("super"), &[]);
    git(&scratch.path("super"), &["submodule", "add", "-q", scratch.path("lib").to_str().unwrap(), "mod"]);

    assert!(scratch.path("super/mod/.git").is_file());
    assert_eq!(anchor(&scratch.path("super/mod")), None);
}

#[test]
fn a_linked_worktree_of_a_submodule_anchors_at_the_submodule() {
    let scratch = Scratch::new("submodule-linked");

    init(&scratch.path("lib"), &[]);
    init(&scratch.path("super"), &[]);
    git(&scratch.path("super"), &["submodule", "add", "-q", scratch.path("lib").to_str().unwrap(), "mod"]);
    git(
        &scratch.path("super/mod"),
        &["worktree", "add", "-q", "-b", "feat", scratch.path("modfeat").to_str().unwrap()],
    );

    assert_eq!(anchor(&scratch.path("modfeat")), Some(scratch.path("super/mod")));
}

#[test]
fn a_separate_git_dir_checkout_is_its_own_anchor() {
    let scratch = Scratch::new("separate");

    init_separate(&scratch);

    assert!(scratch.path("repo/.git").is_file());
    assert_eq!(anchor(&scratch.path("repo")), None);
}

#[test]
fn a_linked_worktree_of_a_separate_git_dir_checkout_keeps_its_own_anchor() {
    let scratch = Scratch::new("separate-linked");

    init_separate(&scratch);
    git(&scratch.path("repo"), &["worktree", "add", "-q", "-b", "feat", scratch.path("feat").to_str().unwrap()]);

    // Nothing in the git dir records where the checkout is; a guessed anchor (`elsewhere`) would be wrong.
    assert_eq!(anchor(&scratch.path("feat")), None);
}

#[test]
fn a_worktree_of_a_bare_repository_anchors_beside_the_bare_directory() {
    let scratch = Scratch::new("bare");

    init(&scratch.path("seed"), &[]);
    git(&scratch.0, &["clone", "-q", "--bare", scratch.path("seed").to_str().unwrap(), "layout/repo.git"]);
    git(
        &scratch.path("layout/repo.git"),
        &["worktree", "add", "-q", scratch.path("layout/main").to_str().unwrap(), "main"],
    );

    assert_eq!(anchor(&scratch.path("layout/main")), Some(scratch.path("layout")));
}

#[test]
fn sparse_checkout_moving_core_worktree_to_the_worktree_config_changes_nothing() {
    // `git sparse-checkout init` enables `extensions.worktreeConfig` and moves `core.worktree` of a
    // submodule out of `config` into `config.worktree`.
    let scratch = Scratch::new("sparse");

    init(&scratch.path("lib"), &[]);
    init(&scratch.path("super"), &[]);
    git(&scratch.path("super"), &["submodule", "add", "-q", scratch.path("lib").to_str().unwrap(), "mod"]);
    git(&scratch.path("super/mod"), &["sparse-checkout", "init", "--cone"]);
    git(
        &scratch.path("super/mod"),
        &["worktree", "add", "-q", "-b", "feat", scratch.path("modfeat").to_str().unwrap()],
    );

    assert_eq!(anchor(&scratch.path("super/mod")), None);
    assert_eq!(anchor(&scratch.path("modfeat")), Some(scratch.path("super/mod")));
}

#[test]
fn a_bare_layout_with_worktree_config_still_anchors_beside_the_bare_directory() {
    let scratch = Scratch::new("bare-worktree-config");

    init(&scratch.path("seed"), &[]);
    git(&scratch.0, &["clone", "-q", "--bare", scratch.path("seed").to_str().unwrap(), "layout/repo.git"]);
    git(&scratch.path("layout/repo.git"), &["config", "extensions.worktreeConfig", "true"]);
    git(
        &scratch.path("layout/repo.git"),
        &["worktree", "add", "-q", scratch.path("layout/main").to_str().unwrap(), "main"],
    );

    assert_eq!(anchor(&scratch.path("layout/main")), Some(scratch.path("layout")));
}
