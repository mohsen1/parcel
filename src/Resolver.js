const builtins = require('./builtins');
const Path = require('path');
const glob = require('glob');
const fs = require('./utils/fs');
const micromatch = require('micromatch');

const EMPTY_SHIM = require.resolve('./builtins/_empty');
const GLOB_RE = /[*+{}]/;

/**
 * This resolver implements a modified version of the node_modules resolution algorithm:
 * https://nodejs.org/api/modules.html#modules_all_together
 *
 * In addition to the standard algorithm, Parcel supports:
 *   - All file extensions supported by Parcel.
 *   - Glob file paths
 *   - Absolute paths (e.g. /foo) resolved relative to the project root.
 *   - Tilde paths (e.g. ~/foo) resolved relative to the nearest module root in node_modules.
 *   - The package.json module, jsnext:main, and browser field as replacements for package.main.
 *   - The package.json browser and alias fields as an alias map within a local module.
 *   - The package.json alias field in the root package for global aliases across all modules.
 */
class Resolver {
  constructor(options = {}) {
    this.options = options;
    this.cache = new Map();
    this.packageCache = new Map();
    this.rootPackage = null;
  }

  /**
   * @param {string} input input path
   * @param {string=} parent parent path
   */
  async resolve(input, parent) {
    let filename = input;

    // Check the cache first
    let key = this.getCacheKey(filename, parent);
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }

    // Check if this is a glob
    if (GLOB_RE.test(filename) && glob.hasMagic(filename)) {
      return {path: Path.resolve(Path.dirname(parent), filename)};
    }

    // Get file extensions to search
    let extensions = Array.isArray(this.options.extensions)
      ? this.options.extensions.slice()
      : Object.keys(this.options.extensions);

    if (parent) {
      // parent's extension given high priority
      const parentExt = Path.extname(parent);
      extensions = [parentExt, ...extensions.filter(ext => ext !== parentExt)];
    }

    extensions.unshift('');

    // Resolve the module directory or local file path
    let module = await this.resolveModule(filename, parent);
    let resolved;

    if (module.moduleDir) {
      resolved = await this.loadNodeModules(module, extensions);
    } else if (module.filePath) {
      resolved = await this.loadRelative(module.filePath, extensions);
    }

    if (!resolved) {
      let dir = parent ? Path.dirname(parent) : process.cwd();
      let err = new Error(`Cannot find module '${input}' from '${dir}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }

    this.cache.set(key, resolved);
    return resolved;
  }

  /**
   * @param {string} filename
   * @param {string=} parent
   */
  async resolveModule(filename, parent) {
    let dir = parent ? Path.dirname(parent) : process.cwd();

    // If this isn't the entrypoint, resolve the input file to an absolute path
    if (parent) {
      filename = this.resolveFilename(filename, dir);
    }

    // Resolve aliases in the parent module for this file.
    filename = await this.loadAlias(filename, dir);

    // Return just the file path if this is a file, not in node_modules
    if (Path.isAbsolute(filename)) {
      return {
        filePath: filename
      };
    }

    // Resolve the module in node_modules
    let resolved;
    try {
      resolved = await this.findNodeModulePath(filename, dir);
    } catch (err) {
      // ignore
    }

    // If we couldn't resolve the node_modules path, just return the module name info
    if (!resolved) {
      let parts = this.getModuleParts(filename);
      resolved = {
        moduleName: parts[0],
        subPath: parts[1]
      };
    }

    return resolved;
  }

  /**
   * @param {string} filename
   * @param {string} parent
   */
  getCacheKey(filename, parent) {
    return (parent ? Path.dirname(parent) : '') + ':' + filename;
  }

  /**
   * @param {string} filename
   * @param {string} dir
   */
  resolveFilename(filename, dir) {
    switch (filename[0]) {
      case '/':
        // Absolute path. Resolve relative to project root.
        return Path.resolve(this.options.rootDir, filename.slice(1));

      case '~':
        // Tilde path. Resolve relative to nearest node_modules directory,
        // or the project root - whichever comes first.
        while (
          dir !== this.options.rootDir &&
          Path.basename(Path.dirname(dir)) !== 'node_modules'
        ) {
          dir = Path.dirname(dir);
        }

        return Path.join(dir, filename.slice(1));

      case '.':
        // Relative path.
        return Path.resolve(dir, filename);

      default:
        // Module
        return Path.normalize(filename);
    }
  }

  /**
   * @param {string} filename
   * @param {string[]} extensions
   */
  async loadRelative(filename, extensions) {
    // Find a package.json file in the current package.
    let pkg = await this.findPackage(Path.dirname(filename));

    // First try as a file, then as a directory.
    return (
      (await this.loadAsFile(filename, extensions, pkg)) ||
      (await this.loadDirectory(filename, extensions, pkg))
    );
  }

  /**
   * @param {string} filename
   * @param {string=} dir
   */
  async findNodeModulePath(filename, dir) {
    if (builtins[filename]) {
      return {filePath: builtins[filename]};
    }

    let parts = this.getModuleParts(filename);
    let root = Path.parse(dir).root;

    while (dir !== root) {
      // Skip node_modules directories
      if (Path.basename(dir) === 'node_modules') {
        dir = Path.dirname(dir);
      }

      try {
        // First, check if the module directory exists. This prevents a lot of unnecessary checks later.
        let moduleDir = Path.join(dir, 'node_modules', parts[0]);
        let stats = await fs.stat(moduleDir);
        if (stats.isDirectory()) {
          return {
            moduleName: parts[0],
            subPath: parts[1],
            moduleDir: moduleDir,
            filePath: Path.join(dir, 'node_modules', filename)
          };
        }
      } catch (err) {
        // ignore
      }

      // Move up a directory
      dir = Path.dirname(dir);
    }
  }

  /**
   * @param {object} module
   * @param {string} extensions
   */
  async loadNodeModules(module, extensions) {
    try {
      // If a module was specified as a module sub-path (e.g. some-module/some/path),
      // it is likely a file. Try loading it as a file first.
      if (module.subPath) {
        let pkg = await this.readPackage(module.moduleDir);
        let res = await this.loadAsFile(module.filePath, extensions, pkg);
        if (res) {
          return res;
        }
      }

      // Otherwise, load as a directory.
      return await this.loadDirectory(module.filePath, extensions);
    } catch (e) {
      // ignore
    }
  }

  /**
   * @param {string} file
   */
  async isFile(file) {
    try {
      let stat = await fs.stat(file);
      return stat.isFile() || stat.isFIFO();
    } catch (err) {
      return false;
    }
  }

  /**
   * @param {string} dir
   * @param {string[]} extensions
   * @param {object=} pkg
   */
  async loadDirectory(dir, extensions, pkg) {
    try {
      pkg = await this.readPackage(dir);

      // First try loading package.main as a file, then try as a directory.
      let main = this.getPackageMain(pkg);
      let res =
        (await this.loadAsFile(main, extensions, pkg)) ||
        (await this.loadDirectory(main, extensions, pkg));

      if (res) {
        return res;
      }
    } catch (err) {
      // ignore
    }

    // Fall back to an index file inside the directory.
    return await this.loadAsFile(Path.join(dir, 'index'), extensions, pkg);
  }

  /**
   * @param {string} dir
   */
  async readPackage(dir) {
    let file = Path.join(dir, 'package.json');
    if (this.packageCache.has(file)) {
      return this.packageCache.get(file);
    }

    let json = await fs.readFile(file, 'utf8');
    let pkg = JSON.parse(json);

    pkg.pkgfile = file;
    pkg.pkgdir = dir;

    // If the package has a `source` field, check if it is behind a symlink.
    // If so, we treat the module as source code rather than a pre-compiled module.
    if (pkg.source) {
      let realpath = await fs.realpath(file);
      if (realpath === file) {
        delete pkg.source;
      }
    }

    this.packageCache.set(file, pkg);
    return pkg;
  }

  /**
   * @param {object} pkg
   */
  getPackageMain(pkg) {
    let {browser} = pkg;

    if (typeof browser === 'object' && browser[pkg.name]) {
      browser = browser[pkg.name];
    }

    // libraries like d3.js specifies node.js specific files in the "main" which breaks the build
    // we use the "module" or "browser" field to get the full dependency tree if available.
    // If this is a linked module with a `source` field, use that as the entry point.
    let main = [pkg.source, pkg.module, browser, pkg.main].find(
      entry => typeof entry === 'string'
    );

    // Default to index file if no main field find
    if (!main || main === '.' || main === './') {
      main = 'index';
    }

    return Path.resolve(pkg.pkgdir, main);
  }

  /**
   * @param {string} file
   * @param {string[]} extensions
   * @param {object} pkg
   */
  async loadAsFile(file, extensions, pkg) {
    // Try all supported extensions
    for (let f of this.expandFile(file, extensions, pkg)) {
      if (await this.isFile(f)) {
        return {path: f, pkg};
      }
    }
  }

  /**
   * @param {string} file
   * @param {string[]} extensions
   * @param {object=} pkg
   * @param {boolean=true} expandAliases
   */
  expandFile(file, extensions, pkg, expandAliases = true) {
    // Expand extensions and aliases
    let res = [];
    for (let ext of extensions) {
      let f = file + ext;

      if (expandAliases) {
        let alias = this.resolveAliases(file + ext, pkg);
        if (alias !== f) {
          res = res.concat(this.expandFile(alias, extensions, pkg, false));
        }
      }

      res.push(f);
    }

    return res;
  }

  /**
   * @param {string} filename
   * @param {object=} pkg
   */
  resolveAliases(filename, pkg) {
    // First resolve local package aliases, then project global ones.
    return this.resolvePackageAliases(
      this.resolvePackageAliases(filename, pkg),
      this.rootPackage
    );
  }

  /**
   * @param {string} filename
   * @param {object=} pkg
   */
  resolvePackageAliases(filename, pkg) {
    if (!pkg) {
      return filename;
    }

    // Resolve aliases in the package.source, package.alias, and package.browser fields.
    return (
      this.getAlias(filename, pkg.pkgdir, pkg.source) ||
      this.getAlias(filename, pkg.pkgdir, pkg.alias) ||
      this.getAlias(filename, pkg.pkgdir, pkg.browser) ||
      filename
    );
  }

  /**
   * @param {string} filename
   * @param {string} dir
   * @param {{[name: string]: string}} aliases
   */
  getAlias(filename, dir, aliases) {
    if (!filename || !aliases || typeof aliases !== 'object') {
      return null;
    }

    let alias;

    // If filename is an absolute path, get one relative to the package.json directory.
    if (Path.isAbsolute(filename)) {
      filename = Path.relative(dir, filename);
      if (filename[0] !== '.') {
        filename = './' + filename;
      }

      alias = this.lookupAlias(aliases, filename);
    } else {
      // It is a node_module. First try the entire filename as a key.
      alias = aliases[filename];
      if (alias == null) {
        // If it didn't match, try only the module name.
        let parts = this.getModuleParts(filename);
        alias = aliases[parts[0]];
        if (typeof alias === 'string') {
          // Append the filename back onto the aliased module.
          alias = Path.join(alias, ...parts.slice(1));
        }
      }
    }

    // If the alias is set to `false`, return an empty file.
    if (alias === false) {
      return EMPTY_SHIM;
    }

    // If the alias is a relative path, then resolve
    // relative to the package.json directory.
    if (alias && alias[0] === '.') {
      return Path.resolve(dir, alias);
    }

    // Otherwise, assume the alias is a module
    return alias;
  }

  /**
   * @param {{[name: string]: string}} aliases
   * @param {string} filename
   */
  lookupAlias(aliases, filename) {
    // First, try looking up the exact filename
    let alias = aliases[filename];
    if (alias != null) {
      return alias;
    }

    // Otherwise, try replacing glob keys
    for (let key in aliases) {
      if (GLOB_RE.test(key)) {
        let re = micromatch.makeRe(key, {capture: true});
        if (re.test(filename)) {
          return filename.replace(re, aliases[key]);
        }
      }
    }
  }

  /**
   * @param {string} dir
   */
  async findPackage(dir) {
    // Find the nearest package.json file within the current node_modules folder
    let root = Path.parse(dir).root;
    while (dir !== root && Path.basename(dir) !== 'node_modules') {
      try {
        return await this.readPackage(dir);
      } catch (err) {
        // ignore
      }

      dir = Path.dirname(dir);
    }
  }

  /**
   * @param {string} filename
   * @param {string} dir
   */
  async loadAlias(filename, dir) {
    // Load the root project's package.json file if we haven't already
    if (!this.rootPackage) {
      this.rootPackage = await this.findPackage(this.options.rootDir);
    }

    // Load the local package, and resolve aliases
    let pkg = await this.findPackage(dir);
    return this.resolveAliases(filename, pkg);
  }

  /**
   * @param {string} name
   */
  getModuleParts(name) {
    let parts = Path.normalize(name).split(Path.sep);
    if (parts[0].charAt(0) === '@') {
      // Scoped module (e.g. @scope/module). Merge the first two parts back together.
      parts.splice(0, 2, `${parts[0]}/${parts[1]}`);
    }

    return parts;
  }
}

module.exports = Resolver;
