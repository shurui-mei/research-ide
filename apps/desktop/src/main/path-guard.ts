import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors';

const INTERNAL_DIR = '.research_ide';
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN_CHARACTER = /[<>:"|?*]/u;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function validateRelativePath(value: string, allowInternal = false): string {
  if (typeof value !== 'string' || value.length > 8_192 || value.includes('\0')) {
    throw new AppError('INVALID_PATH', 'Path must be a valid string');
  }
  const normalizedInput = value.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalizedInput) || /^[A-Za-z]:\//u.test(normalizedInput)) {
    throw new AppError('INVALID_PATH', 'Absolute paths are not accepted here');
  }
  const normalized = path.posix.normalize(normalizedInput).replace(/^\.\//u, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new AppError('PATH_OUTSIDE_PROJECT', 'Path is outside the project');
  }
  for (const component of normalized.split('/')) {
    if (!component) continue;
    if (WINDOWS_FORBIDDEN_CHARACTER.test(component) || containsControlCharacter(component) || /[ .]$/u.test(component) || WINDOWS_RESERVED_NAME.test(component)) {
      throw new AppError('INVALID_PATH', 'Path contains a Windows device name, alternate stream, or non-portable component');
    }
  }
  const first = normalized.split('/')[0]?.toLowerCase();
  if (!allowInternal && first === INTERNAL_DIR) {
    throw new AppError('INTERNAL_PATH', 'The project metadata directory is managed by Research IDE');
  }
  return normalized === '.' ? '' : normalized;
}

export class ProjectPathGuard {
  private constructor(public readonly root: string) {}

  static async create(root: string): Promise<ProjectPathGuard> {
    const canonical = await realpath(path.resolve(root));
    const stat = await lstat(canonical);
    if (!stat.isDirectory()) throw new AppError('NOT_A_DIRECTORY', 'Project path is not a directory');
    return new ProjectPathGuard(canonical);
  }

  lexical(relativePath: string, allowInternal = false): string {
    const relative = validateRelativePath(relativePath, allowInternal);
    const candidate = path.resolve(this.root, ...relative.split('/'));
    if (!isInside(this.root, candidate)) throw new AppError('PATH_OUTSIDE_PROJECT', 'Path is outside the project');
    return candidate;
  }

  async existing(relativePath: string, allowInternal = false): Promise<string> {
    const candidate = this.lexical(relativePath, allowInternal);
    const canonical = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new AppError('NOT_FOUND', 'Project file does not exist');
      throw error;
    });
    if (!isInside(this.root, canonical)) throw new AppError('PATH_OUTSIDE_PROJECT', 'A symbolic link points outside the project');
    return canonical;
  }

  async writable(relativePath: string, allowInternal = false): Promise<string> {
    const candidate = this.lexical(relativePath, allowInternal);
    let ancestor = candidate;
    for (;;) {
      try {
        const canonical = await realpath(ancestor);
        if (!isInside(this.root, canonical)) throw new AppError('PATH_OUTSIDE_PROJECT', 'A symbolic link points outside the project');
        break;
      } catch (error) {
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new AppError('PATH_OUTSIDE_PROJECT', 'No safe parent directory was found');
        ancestor = parent;
      }
    }
    return candidate;
  }

  relative(absolutePath: string): string {
    const relative = path.relative(this.root, absolutePath);
    if (!isInside(this.root, absolutePath)) throw new AppError('PATH_OUTSIDE_PROJECT', 'Path is outside the project');
    return relative.split(path.sep).join('/');
  }

  async assertExecutable(absolutePath: string): Promise<string> {
    const resolved = path.resolve(absolutePath);
    const canonical = await realpath(resolved);
    await access(canonical, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    const stat = await lstat(canonical);
    if (!stat.isFile()) throw new AppError('INVALID_EXECUTABLE', 'Selected executable is not a file');
    return canonical;
  }
}
