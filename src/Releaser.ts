import {IBumpFinder} from './bumpFinder/IBumpFinder';
import {ICliBootstrap} from './cli/ICliBootstrap';
import {IConfig} from './config/IConfig';
import {IExecReturnObject} from './exec/IExecReturnObject';
import {IExecutor} from './exec/IExecutor';
import {ILogger} from './debug/ILogger';
import {IPkgUpResultObject} from './config/IPkgResultObject';
import {IPrompt} from './prompt/IPrompt';
import {resolve as pathResolve, dirname, relative, sep} from 'path';
import {UserAbortedError} from './exceptions/UserAbortedError';
import {ISemVer} from './semver/ISemVer';
import {readPkgUp} from './others/types';

const ERRORS = {
  exhaustedDir:   'Exhausted all directories within repository.',
  invalidVersion: 'Version in selected package.json does not follow semver.',
  noNewCommit:    'No new commits since last tag, aborting.',
  noPackage:      'No package.json found.',
  noTag:          'No tags are found.',
};

const enum BRANCH_STATUS {
  FORCED_BUMP   = 1,
  INVALID_LABEL = 2,
  // INVALID_TAG   = 3,
  NO_TAG        = 4,
  // NOT_PRISTINE  = 5,
  // PRISTINE      = 6,
}

export class Releaser {

  /**
   * The root path of the related repository.
   *
   * @type {string}
   */
  private repoRootPath: string;

  /**
   * The path that is currently being searched.
   *
   * @type {string}
   */
  private currentSearchPath: string;

  /**
   * Removes the new line chars \n from a stdout result.
   *
   * @param results
   * @returns {string}
   */
  private static removeNewLine(results: IExecReturnObject): string {
    if (typeof results !== 'object') {
      throw new Error('The results must be an object.');
    }

    const {stdout} = results;

    if (stdout === undefined || stdout === null) {
      throw new Error('The results must have the stdout property.');
    }

    return results.stdout.replace(/\n/, '');
  }

  /**
   * Construct a new Releaser with the given parameters.
   *
   * @param {ICliBootstrap} cli The CLI wrapper.
   * @param {ILogger} logger A Logger implementation.
   * @param {IConfig} config A config implementation.
   * @param {IBumpFinder} bumpFinder The implementation of a bumpFinder.
   * @param {IExecutor} executor A shell exec implementation.
   * @param {IPrompt} prompt A shell prompt implementation.
   * @param {ISemVer} semver The semver wrapper.
   * @param {readPkgUp} readPkgUp A shell prompt implementation.
   */
  constructor(
    private cli: ICliBootstrap,
    private logger: ILogger,
    private config: IConfig,
    private bumpFinder: IBumpFinder,
    private executor: IExecutor,
    private prompt: IPrompt,
    private semver: ISemVer,
    private readPkgUp: readPkgUp,
  ) {
    this.currentSearchPath = process.cwd();
  }

  /**
   * Checks the branch and bumps it accordingly.
   *
   * @return Promise<void>
   */
  public init(): Promise<void> {
    this.logger.debug('starting');

    this.cli.init();
    this.setDefaultConfig();

    const promise = this.config.isPackageJsonExhausted() ?
      Promise.resolve() : this.setPackageJsonInConfig();

    return promise
      .then(() => this.syncSemVerVersions())
      .then(() => {
        if (this.config.isPackageJsonValid() || this.config.hasCurrentSemVer()) {
          return this.bump();
        }

        throw new Error('Unknown config state.');
      })
      .then(() => this.logger.debug('init completed'))
      .catch(reason => {
        if (reason instanceof UserAbortedError) {
          return this.logger.info('Aborting.');
        } else if (reason === ERRORS.noNewCommit) {
          return this.logger.warn(ERRORS.noNewCommit);
        }

        throw reason;
      });
  }

  /**
   * Sets the default configuration state.
   *
   * @return void
   */
  private setDefaultConfig(): void {
    this.findBranchRootDir().then(results => this.repoRootPath = results);

    if (this.cli.isReset()) this.config.reset();
    if (this.cli.isFindJsonMode()) this.config.setPackageJsonExhaustStatus(false);
  }

  /**
   * Checks if the branch has any commits since last tag made.
   *
   * @return {Promise<boolean>}
   */
  private isBranchPristine(): Promise<boolean> {
    return this.isAnyTagPresent()
      .then(value => {
        if (value === false) return Promise.reject(BRANCH_STATUS.NO_TAG);
      })
      .then(() => {
        const currentTag = this.getCurrentTag();

        return this.isTagPresent(currentTag)
          .then((isTagPresent): Promise<string> => {
            if (!isTagPresent) {
              return this.prompt.confirm(
                `Tag ${currentTag} is not present in repository, continue?`,
              ).then(answer => {
                if (answer === false) throw new UserAbortedError();

                return this.createTag(currentTag)
                  .then(() => {
                    if (this.cli.shouldCommit() === true) {
                      this.logger.info(`Forced bump to ${currentTag} completed.`);

                      return;
                    }

                    this.logger.info(`Forced bump to ${currentTag} completed, no commits made.`);
                  })
                  .then(() => Promise.reject(BRANCH_STATUS.FORCED_BUMP));
              });
            }

            return Promise.resolve(currentTag);
          });
      })
      .then(currentTag => this.getHashFromTag(currentTag))
      .then(hash => this.executor.perform(`git rev-list ${hash}..HEAD --count`))
      .then(Releaser.removeNewLine)
      .then(count => (parseInt(count, 10) === 0));
  }

  /**
   * Gets the current tag from the config.
   *
   * @return {string}
   */
  private getCurrentTag(prefixed = this.cli.hasPrefix()): string {
    const version = this.config.isPackageJsonValid() ?
      this.config.getPackageJsonVersion() : this.config.getCurrentSemVer();

    return prefixed ? 'v'.concat(version) : version;
  }

  /**
   * Sets a valid package.json file in config.
   *
   * @return {Promise<void>}
   */
  private setPackageJsonInConfig(): Promise<void> {
    return this.findPackageJsonFile()
      .then(file => this.askUserIfPackageJsonFileIsCorrect(file))
      .then(answer => this.handleIsPackageJsonFileIsCorrectResponse(answer))
      .catch(reason => {
        if (reason === ERRORS.exhaustedDir || ERRORS.noPackage) {
          return this.logger.debug(reason);
        }

        throw reason;
      });
  }

  /**
   * Finds a file from the perspective of the directory given.
   *
   * @param {string=} cwd The directory to start from.
   * @return {Promise<IPkgUpResultObject>}
   */
  private findPackageJsonFile(cwd = this.currentSearchPath): Promise<IPkgUpResultObject> {
    return this.readPkgUp({cwd})
      .then(file => {
        if (typeof file !== 'object' || Object.keys(file).length === 0) {
          throw new Error(ERRORS.noPackage);
        }

        return file;
      })
      .catch(err => {
        if (err instanceof Error && /Invalid version:/.test(err.message)) {
          return this.readPkgUp({cwd, normalize: false}).then(result => {
            throw new Error(`${ERRORS.invalidVersion} \n File: ${result.path} \n ${err.message}`);
          });
        }

        throw err;
      });
  }

  /**
   * Ask the user if the given file is valid or not.
   *
   * @param {IPkgUpResultObject} file The file in question.
   * @return {Promise<string>} The user's answer, yes, no, and optionally abort.
   */
  private askUserIfPackageJsonFileIsCorrect(file: IPkgUpResultObject): Promise<string> {
    this.config.setPackageJson(file);
    let message: string;
    const choices = ['Yes', 'No'];

    if (file === null) {
      message = 'No package.json found, keep looking?';
    } else {
      message = `Package.json found in ${file.path}, is this file correct?`;
      choices.push('Abort');
    }

    return this.prompt.list(message, choices);
  }

  /**
   * Handles an user prompt response about the findings of a particular package.json file.
   *
   * @param {string} answer The answer the user gave.
   * @return {Promise<void>}
   */
  private handleIsPackageJsonFileIsCorrectResponse(answer: string): Promise<void> {
    return Promise.resolve()
      .then(() => {
        if (this.config.isPackageJsonExhausted()) return Promise.reject(ERRORS.exhaustedDir);
      })
      .then(() => {
        switch (answer) {
          case 'Yes':
            this.config.setPackageJsonValidity(true);
            this.config.setPackageJsonExhaustStatus(true);
            break;
          case 'No':
            const packageJson = this.config.getPackageJson();
            this.config.deletePackageJson();

            this.currentSearchPath = dirname(packageJson.path);

            // splits the relative path between the directories, ex: ['..', '..'] or ['']
            // https://nodejs.org/api/path.html#path_path_relative_from_to
            const pathSplit = relative(this.currentSearchPath, this.repoRootPath).split(sep);

            // '' means the directories are equal, no '..' means the dir is outside the root
            if (pathSplit[0] === '' || pathSplit[0] !== '..') {
              this.config.setPackageJsonExhaustStatus(true);
              this.config.setPackageJsonValidity(false);

              return Promise.reject(ERRORS.exhaustedDir);
            }

            this.currentSearchPath = pathResolve(this.currentSearchPath, '../');

            return this.findPackageJsonFile(this.currentSearchPath)
              .then(file => this.askUserIfPackageJsonFileIsCorrect(file))
              .then(response => this.handleIsPackageJsonFileIsCorrectResponse(response));
          case 'Abort':
            throw new UserAbortedError();
          default:
            throw new Error('Unknown answer.');
        }
      });
  }

  /**
   * Checks if tags exist in a branch.
   *
   * @returns {Promise<boolean>}
   */
  private isAnyTagPresent(): Promise<boolean> {
    return this.executor.perform('git tag')
      .then(results => (results.stdout.length > 0));
  }

  /**
   * Gets a hash from a given tag.
   *
   * @param {string} tag The tag to get the hash from.
   * @returns {Promise<string>}
   */
  private getHashFromTag(tag: string): Promise<string> {
    return this.executor.perform(`git show-ref -s ${tag}`)
      .then(Releaser.removeNewLine).catch(reason => {
        // tag label not found
        if (reason.code === 1) {
          return Promise.reject(BRANCH_STATUS.INVALID_LABEL);
        }

        throw reason;
      });
  }

  /**
   * Uses git to find the root directory of the current path.
   * @link http://stackoverflow.com/a/957978
   *
   * @return {Promise<string>}
   */
  private findBranchRootDir(): Promise<string> {
    return this.executor.perform('git rev-parse --show-toplevel')
      .then(Releaser.removeNewLine);
  }

  /**
   * Creates a new tag with the given label and prefix.
   *
   * @param {string} label The tag label.
   * @return {Promise<void>}
   */
  private createTag(label: string): Promise<void> {
    return this.executor.perform(`git tag ${label}`)
      .then(() => this.logger.debug(`created new tag as ${label}`))
      .catch(err => {
        if (err.code === 128 && /already exists/.test(err.stderr)) {
          throw new Error(err.stderr);
        }

        throw err;
      });
  }

  /**
   * Bumps the current branch to the next semver number.
   *
   * @return {Promise<void>}
   */
  private bump(): Promise<void> {
    return Promise.resolve()
      .then(() => {
        return this.isBranchPristine()
          .catch(reason => {
            switch (reason) {
              case BRANCH_STATUS.NO_TAG:
              case BRANCH_STATUS.INVALID_LABEL:
                return Promise.resolve(false);
              default:
                throw reason;
            }
          });
      })
      .then(results => {
        if (results === true && !this.cli.isForced()) {
          return Promise.reject(ERRORS.noNewCommit);
        }

        const label = this.constructNewLabel(this.getCurrentTag(), this.getBumpType());

        return this.createTag(label)
          .then(() => {
            if (this.config.isPackageJsonValid()) {
              this.config.setPackageJsonVersion(label);
            }

            this.config.setCurrentSemVer(label);
          })
          .then(() => {
            if (this.cli.shouldCommit() === true) {
              this.logger.info(`Bump to ${label} completed.`);

              return;
            }

            this.logger.info(`Bump to ${label} completed, no commits made.`);
          });
      })
      .catch(err => {
        if (err === BRANCH_STATUS.FORCED_BUMP) {
          // forced bump finishes the bump completely.
          return;
        }

        throw err;
      });
  }

  /**
   * Sync the package.json version with current semver in config.
   *
   * @return {Promise<boolean>}
   */
  private syncSemVerVersions(): Promise<void> {
    // check if package.json exists, to set the version from it
    // if not, find the latest version through git.
    const promise = this.config.isPackageJsonValid() ?
      Promise.resolve([this.config.getPackageJsonVersion()]) : this.getAllSemVerTags();

    return promise.then(tags => this.setLatestSemVerInConfig(tags));
  }

  /**
   * Gets all the valid semantic version tags.
   *
   * @return {Promise<string[]>}
   */
  private getAllSemVerTags(): Promise<string[]> {
    /**
     * This regex matches tags with a valid semver.
     *
     * ^ asserts position at start of a line
     * v? matches the 'variable prefix' literally (case sensitive)
     * \d+ matches a digit (equal to [0-9])
     * \. matches the character . literally (case sensitive)
     * \d+ matches a digit (equal to [0-9])
     * \. matches the character . literally (case sensitive)
     * \d+ matches a digit (equal to [0-9])
     * \-? matches the character - literally (case sensitive)
     * Non-capturing group (?:\d*|\w*\.\d+)
     *    1st Alternative \d*
     *      \d* matches a digit (equal to [0-9])
     *    2nd Alternative \w*\.\d+
     *      \w* matches any word character (equal to [a-zA-Z0-9_])
     *      \. matches the character . literally (case sensitive)
     *      \d+ matches a digit (equal to [0-9])
     *
     * @type {RegExp}
     */
    const regex     = /^v?\d+\.\d+\.\d+-?(?:\d*|\w*\.\d+)$/;
    const validTags = [];

    return Promise.resolve()
      .then(() => this.executor.perform('git tag'))
      .then(value => {
        const tags = value.stdout.split('\n')
          .filter(tag => tag.length > 1);

        tags.forEach(tag => {
          if (regex.test(tag)) {
            validTags.push(tag);
          }
        });

        return validTags;
      });
  }

  /**
   * Sets the last valid semantic version tag into the config file.
   *
   * @return {Promise<boolean>}
   */
  private setLatestSemVerInConfig(tags: string[]): Promise<void> {
    return Promise.resolve().then(() => {
      if (tags.length === 0) {
        this.config.deleteCurrentSemVer();
        return this.prompt.confirm('No valid semver tags found, continue?')
          .then((answer): Promise<void> => {
            if (answer === false) return Promise.reject(new UserAbortedError());

            const label = this.cli.hasPrefix() ? 'v0.0.1' : '0.0.1';
            this.config.setCurrentSemVer(label);
          });
      }

      const sorted = tags.sort(this.semver.rCompare);
      this.config.setCurrentSemVer(sorted[0]);
    });
  }

  /**
   * Makes a new label from current one.
   *
   * @param {string} name The label name.
   * @param {string} type The type to construct from (minor, major, etc).
   * @return {string}
   */
  private constructNewLabel(name: string, type: string) {
    const label = this.incrementSemVer(name, type);

    return this.cli.hasPrefix() ? 'v'.concat(label) : label;
  }

  /**
   * Checks if the given tag is present in the repository.
   *
   * @link http://stackoverflow.com/a/43156178
   * @param label
   * @return {Promise<any>}
   */
  private isTagPresent(label: string): Promise<boolean> {
    return this.executor.perform(`git tag -l ${label}`)
      .then(Releaser.removeNewLine)
      .then(value => (value.length > 0));
  }

  /**
   * Gets the bump type (minor, major, etc).
   *
   * @return {string}
   */
  private getBumpType(): string {
    return this.cli.isAuto() ?
      this.bumpFinder.getBumpType() : this.cli.getRelease();
  }

  /**
   * Returns the current branch name.
   *
   * @return {Promise<any>}
   */
  private getCurrentBranchName(): Promise<string> {
    return this.executor.perform('git rev-parse --abbrev-ref HEAD')
      .then(Releaser.removeNewLine);
  }

  /**
   * Uses semver to increment a tag version.
   *
   * @param {string} label The current label.
   * @param {string} type
   * @param {string=} suffix
   * @return {string}
   */
  private incrementSemVer(label: string, type: string, suffix?: string): string {
    if (!this.semver.valid(label)) {
      throw new Error(`The provided label ${label} does not follow semver.`);
    }

    switch (type) {
      case 'prerelease':
        return this.semver.inc(label, type, suffix as any);
      case 'major':
      case 'minor':
      case 'patch':
      case 'premajor':
      case 'preminor':
      case 'prepatch':
        return this.semver.inc(label, type);
      default:
        throw new Error(`Invalid type ${type} provided.`);
    }
  }
}
