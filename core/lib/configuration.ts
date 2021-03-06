/* eslint-disable @typescript-eslint/no-use-before-define */
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { exists, filePath, isDirectory } from '@azure-tools/async-io';
import { BlameTree, DataHandle, DataStore, IFileSystem, LazyPromise, ParseToAst, RealFileSystem, createSandbox, Stringify, stringify, TryDecodeEnhancedPositionFromName } from '@azure-tools/datastore';
import { Extension, ExtensionManager, LocalExtension } from '@azure-tools/extension';
import { clone, keys, Dictionary, values } from '@azure-tools/linq';
import { CreateFileUri, CreateFolderUri, EnsureIsFolderUri, ExistsUri, ResolveUri, simplifyUri, IsUri, FileUriToPath, CreateFileOrFolderUri } from '@azure-tools/uri';
import { From } from 'linq-es2015';
import { basename, dirname, join } from 'path';
import { CancellationToken, CancellationTokenSource } from 'vscode-jsonrpc';
import { Artifact } from './artifact';
import * as Constants from './constants';
import { EventEmitter, IEvent } from './events';
import { OperationAbortedException } from './exception';
import { Channel, Message, Range, SourceLocation } from './message';
import { evaluateGuard, parseCodeBlocks } from './parsing/literate-yaml';
import { AutoRestExtension } from './pipeline/plugin-endpoint';
import { Suppressor } from './pipeline/suppression';
import { MergeOverwriteOrAppend, resolveRValue } from './source-map/merging';
import { Initializer, DeepPartial } from '@azure-tools/codegen';
import { IdentifyDocument } from './autorest-core';
import { cwd } from 'process';

const safeEval = createSandbox();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const untildify: (path: string) => string = require('untildify');

const RESOLVE_MACROS_AT_RUNTIME = true;

export interface AutoRestConfigurationImpl {
  __info?: string | null;
  'allow-no-input'?: boolean;
  'input-file'?: Array<string> | string;
  'exclude-file'?: Array<string> | string;
  'base-folder'?: string;
  'directive'?: Array<Directive> | Directive;
  'declare-directive'?: { [name: string]: string };
  'output-artifact'?: Array<string> | string;
  'message-format'?: 'json' | 'yaml' | 'regular';
  'use-extension'?: { [extensionName: string]: string };
  'require'?: Array<string> | string;
  'try-require'?: Array<string> | string;
  'help'?: any;
  'vscode'?: any; // activates VS Code specific behavior and does *NOT* influence the core's behavior (only consumed by VS Code extension)

  'override-info'?: any; // make sure source maps are pulling it! (see "composite swagger" method)
  'title'?: any;
  'description'?: any;

  'debug'?: boolean;
  'verbose'?: boolean;
  'time'?: boolean;

  // plugin specific
  'output-file'?: string;
  'output-folder'?: string;

  // from here on: CONVENTION, not cared about by the core
  'client-side-validation'?: boolean; // C#
  'fluent'?: boolean;
  'azure-arm'?: boolean;
  'namespace'?: string;
  'license-header'?: string;
  'add-credentials'?: boolean;
  'package-name'?: string; // Ruby, Python, ...
  'package-version'?: string;
  'sync-methods'?: 'all' | 'essential' | 'none';
  'payload-flattening-threshold'?: number;
  'openapi-type'?: string; // the specification type (ARM/Data-Plane/Default)
  'tag'?: string;
  'simple-tree-shake'?: boolean;

  // multi-api specific
  'profiles'?: any;
  'profile'?: Array<string> | string;
  'api-version'?: Array<string>;

  'pipeline-model'?: string;
  'load-priority'?: number;

  'resolved-directive'?: any;
  'debugger'?: any;
}

export function MergeConfigurations(...configs: Array<AutoRestConfigurationImpl>): AutoRestConfigurationImpl {
  let result: AutoRestConfigurationImpl = {};
  configs = configs.map((each, i, a) => ({ ...each, 'load-priority': each['load-priority'] || -i })).sort((a, b) => (b['load-priority']) - (a['load-priority']));
  // if they say --profile: or --api-version: (or in config) then we force it to set the tag=all-api-versions
  // Some of the rest specs had a default tag set (really shouldn't have done that), which ... was problematic, 
  // so this enables us to override that in the case they are asking for filtering to a profile or a api-verison

  const forceAllVersionsMode = !!(configs.find(each => (each['api-version']?.length || each.profile?.length || 0 > 0)));
  for (const config of configs) {
    result = MergeConfiguration(result, config, forceAllVersionsMode);
  }
  result['load-priority'] = undefined;
  return result;
}

// TODO: operate on DataHandleRead and create source map!
function MergeConfiguration(higherPriority: AutoRestConfigurationImpl, lowerPriority: AutoRestConfigurationImpl, forceAllVersionsMode = false): AutoRestConfigurationImpl {
  // check guard
  if (lowerPriority.__info && !evaluateGuard(lowerPriority.__info, higherPriority, forceAllVersionsMode)) {
    // guard false? => skip
    return higherPriority;
  }

  // merge
  return MergeOverwriteOrAppend(higherPriority, lowerPriority);
}

function isIterable(target: any): target is Iterable<any> {
  return !!target && typeof (target[Symbol.iterator]) === 'function';
}

function* valuesOf<T>(value: any): Iterable<T> {

  switch (typeof value) {
    case 'string':
      yield <T><any>value;
      break;

    case 'object':
      if (value) {
        if (isIterable(value)) {
          yield* value;
        } else {
          yield value;
        }
        return;
      }
      break;

    default:
      if (value) {
        yield value;
      }
  }
  /* rewrite
  if (value === undefined) {
    return [];
  }
  if (value instanceof Array) {
    return value;
  }
  return [value];
  */
}

function arrayOf<T>(value: any): Array<T> {
  if (value === undefined) {
    return [];
  }
  switch (typeof value) {
    case 'string':
      return [<T><any>value];
    case 'object':
      if (isIterable(value)) {
        return [...value];
      }
      break;
  }
  return [<T>value];
}

export interface Directive extends Dictionary<any> {
  from?: Array<string> | string;
  where?: Array<string> | string;
  reason?: string;

  // one of:
  suppress?: Array<string> | string;
  set?: Array<string> | string;
  transform?: Array<string> | string;
  test?: Array<string> | string;
}

export class ResolvedDirective extends Initializer implements Dictionary<any> {
  from: Array<string>;
  where: Array<string>;
  reason?: string;
  suppress: Array<string>;
  transform: Array<string>;
  test: Array<string>;

  constructor(directive: Directive) {
    super();

    // copy untyped content over
    this.apply(directive);

    // normalize typed content
    this.from = arrayOf(directive['from']);
    this.where = arrayOf(directive['where']);
    this.reason = directive.reason;
    this.suppress = arrayOf(directive['suppress']);
    this.transform = arrayOf(directive['transform'] || directive['text-transform']);
    this.test = arrayOf(directive['test']);
  }
}

export class MessageEmitter extends EventEmitter {
  /**
   * Event: Signals when a File is generated
   */
  @EventEmitter.Event public GeneratedFile!: IEvent<MessageEmitter, Artifact>;
  /**
   * Event: Signals when a Folder is supposed to be cleared
   */
  @EventEmitter.Event public ClearFolder!: IEvent<MessageEmitter, string>;
  /**
   * Event: Signals when a message is generated
   */
  @EventEmitter.Event public Message!: IEvent<MessageEmitter, Message>;
  private cancellationTokenSource = new CancellationTokenSource();

  constructor() {
    super();
    this.DataStore = new DataStore(this.CancellationToken);
  }
  /* @internal */ public DataStore: DataStore;
  /* @internal */ public get messageEmitter() { return this; }
  /* @internal */ public get CancellationTokenSource(): CancellationTokenSource { return this.cancellationTokenSource; }
  /* @internal */ public get CancellationToken(): CancellationToken { return this.cancellationTokenSource.token; }
}

function ProxifyConfigurationView(cfgView: any) {

  return new Proxy(cfgView, {
    get: (target, property) => {
      const value = (target)[property];
      if (value && value instanceof Array) {
        return value.map(each => resolveRValue(each, '', target, null));
      }
      return resolveRValue(value, <string>property, cfgView, null);
    }
  });
}

const loadedExtensions: { [fullyQualified: string]: { extension: Extension; autorestExtension: LazyPromise<AutoRestExtension> } } = {};
/*@internal*/
export async function getExtension(fullyQualified: string): Promise<AutoRestExtension> {
  return loadedExtensions[fullyQualified].autorestExtension;
}

export class ConfigurationView {
  [name: string]: any;

  private suppressor: Suppressor;

  /* @internal */ constructor(
    /* @internal */public configurationFiles: { [key: string]: any },
    /* @internal */public fileSystem: IFileSystem,
    /* @internal */public messageEmitter: MessageEmitter,
    /* @internal */public configFileFolderUri: string,
    ...configs: Array<AutoRestConfigurationImpl> // decreasing priority
  ) {
    // TODO: fix configuration loading, note that there was no point in passing that DataStore used
    // for loading in here as all connection to the sources is lost when passing `Array<AutoRestConfigurationImpl>` instead of `DataHandleRead`s...
    // theoretically the `ValuesOf` approach and such won't support blaming (who to blame if $.directives[3] sucks? which code block was it from)
    // long term, we simply gotta write a `Merge` method that adheres to the rules we need in here.
    this.rawConfig = <any>{
      'directive': [],
      'input-file': [],
      'exclude-file': [],
      'profile': [],
      'output-artifact': [],
      'require': [],
      'try-require': [],
      'use': [],
      'pass-thru': [],
    };

    this.rawConfig = MergeConfigurations(this.rawConfig, ...configs);

    // default values that are the least priority.
    // TODO: why is this here and not in default-configuration?
    this.rawConfig = MergeConfiguration(this.rawConfig, <any>{
      'base-folder': '.',
      'output-folder': 'generated',
      'debug': false,
      'verbose': false,
      'disable-validation': false
    });

    if (RESOLVE_MACROS_AT_RUNTIME) {
      // if RESOLVE_MACROS_AT_RUNTIME is set
      // this will insert a Proxy object in most of the uses of
      // the configuration, and will do a macro resolution when the
      // value is retrieved.

      // I have turned on this behavior by default. I'm not sure that
      // I need it at this point, but I'm leaving this code here since
      // It's possible that I do.
      this.config = ProxifyConfigurationView(this.rawConfig);
    } else {
      this.config = this.rawConfig;
    }
    this.suppressor = new Suppressor(this);

    // treat this as a configuration property too.
    (<any>(this.rawConfig)).configurationFiles = configurationFiles;
  }

  public get Keys(): Array<string> {
    return Object.getOwnPropertyNames(this.config);
  }

  /* @internal */ public updateConfigurationFile(filename: string, content: string) {
    // only name itself is allowed here, no path
    filename = basename(filename);

    const keys = Object.getOwnPropertyNames(this.configurationFiles);

    if (keys && keys.length > 0) {
      const path = dirname(keys[0]);
      if (path.startsWith('file://')) {
        // the configuration is a file path
        // we can save the configuration file to the target location
        this.GeneratedFile.Dispatch({ content, type: 'configuration', uri: `${path}/${filename}` });
      }
    }
  }

  public Dump(title = ''): void {
    console.log(`\n${title}\n===================================`);
    for (const each of Object.getOwnPropertyNames(this.config)) {
      console.log(`${each} : ${(<any>this.config)[each]}`);
    }
  }

  /* @internal */ public get Indexer(): ConfigurationView {
    return new Proxy<ConfigurationView>(this, {
      get: (target, property) => {
        return property in target.config ? (<any>target.config)[property] : this[<number | string>property];
      }
    });
  }

  /* @internal */ public get DataStore(): DataStore { return this.messageEmitter.DataStore; }
  /* @internal */ public get CancellationToken(): CancellationToken { return this.messageEmitter.CancellationToken; }
  /* @internal */ public get CancellationTokenSource(): CancellationTokenSource { return this.messageEmitter.CancellationTokenSource; }
  /* @internal */ public get GeneratedFile(): IEvent<MessageEmitter, Artifact> { return this.messageEmitter.GeneratedFile; }
  /* @internal */ public get ClearFolder(): IEvent<MessageEmitter, string> { return this.messageEmitter.ClearFolder; }

  private config: AutoRestConfigurationImpl;
  private rawConfig: AutoRestConfigurationImpl;

  private ResolveAsFolder(path: string): string {
    return EnsureIsFolderUri(ResolveUri(this.BaseFolderUri, path));
  }
  private ResolveAsWriteableFolder(path: string): string {
    // relative paths are relative to the local folder when the base-folder is remote.
    if (!this.BaseFolderUri.startsWith('file:')) {
      return EnsureIsFolderUri(ResolveUri(CreateFileOrFolderUri(cwd() + '/'), path));
    }
    return this.ResolveAsFolder(path);
  }
  private ResolveAsPath(path: string): string {
    return ResolveUri(this.BaseFolderUri, path);
  }

  private get BaseFolderUri(): string {
    return EnsureIsFolderUri(ResolveUri(this.configFileFolderUri, <string>this.config['base-folder']));
  }

  // public methods

  public get UseExtensions(): Array<{ name: string; source: string; fullyQualified: string }> {
    const useExtensions = this.Indexer['use-extension'] || {};
    return Object.keys(useExtensions).map(name => {
      const source = useExtensions[name].startsWith('file://') ? FileUriToPath(useExtensions[name]) : useExtensions[name];
      return {
        name,
        source,
        fullyQualified: JSON.stringify([name, source])
      };
    });
  }

  public static async *getIncludedConfigurationFiles(configView: () => ConfigurationView, fileSystem: IFileSystem, ignoreFiles: Set<string>) {

    let done = false;

    while (!done) {
      // get a fresh copy of the view every time we start the loop.
      const view = configView();

      // if we make it thru the list, we're done.
      done = true;
      for (const each of valuesOf<string>(view.config['require'])) {
        if (ignoreFiles.has(each)) {
          continue;
        }

        // looks like we found one that we haven't handled yet.
        done = false;
        ignoreFiles.add(each);
        yield view.ResolveAsPath(each);
        break;
      }
    }

    done = false;
    while (!done) {
      // get a fresh copy of the view every time we start the loop.
      const view = configView();

      // if we make it thru the list, we're done.
      done = true;
      for (const each of valuesOf<string>(view.config['try-require'])) {
        if (ignoreFiles.has(each)) {
          continue;
        }

        // looks like we found one that we haven't handled yet.
        done = false;
        ignoreFiles.add(each);
        const path = view.ResolveAsPath(each);
        try {
          if (await fileSystem.ReadFile(path)) {
            yield path;
          }
        } catch {
          // do nothing
        }

        break;
      }

    }
  }

  public resolveDirectives(predicate?: (each: ResolvedDirective) => boolean) {
    // optionally filter by predicate.
    const plainDirectives = values(valuesOf<Directive>(this.config['directive']));
    // predicate ? values(valuesOf<Directive>(this.config['directive'])).where(predicate) : values(valuesOf<Directive>(this.config['directive']));

    const declarations = this.config['declare-directive'] || {};
    const expandDirective = (dir: Directive): Iterable<Directive> => {
      const makro = Object.keys(dir).filter(m => declarations[m])[0];
      // const makro = keys(dir).first(m => !!declarations[m]);
      if (!makro) {
        return [dir]; // nothing to expand
      }
      // prepare directive
      let parameters = (<any>dir)[makro];
      if (!Array.isArray(parameters)) {
        parameters = [parameters];
      }
      dir = { ...dir };
      delete (<any>dir)[makro];
      // call makro
      const makroResults: any = From(parameters).SelectMany(parameter => {
        const result = safeEval(declarations[makro], { $: parameter, $context: dir });
        return Array.isArray(result) ? result : [result];
      }).ToArray();
      return From(makroResults).SelectMany((result: any) => expandDirective({ ...result, ...dir }));
    };
    // makro expansion
    if (predicate) {
      return plainDirectives.selectMany(expandDirective).select(each => new ResolvedDirective(each)).where(predicate).toArray();
    }
    return plainDirectives.selectMany(expandDirective).select(each => new ResolvedDirective(each)).toArray();
    // return From(plainDirectives).SelectMany(expandDirective).Select(each => new StaticDirectiveView(each)).ToArray();
  }

  public get InputFileUris(): Array<string> {
    const inputFiles = From<string>(valuesOf<string>(this.config['input-file']))
      .Select(each => this.ResolveAsPath(each))
      .ToArray();

    const filesToExclude = From<string>(valuesOf<string>(this.config['exclude-file']))
      .Select(each => this.ResolveAsPath(each))
      .ToArray();

    return inputFiles.filter(x => !filesToExclude.includes(x));
  }

  public get OutputFolderUri(): string {
    return this.ResolveAsWriteableFolder(<string>this.config['output-folder']);
  }

  public get HeaderText(): string {
    const h = this.rawConfig['header-definitions'];
    const version = (<any>global).autorestVersion;

    switch (this.rawConfig['license-header']?.toLowerCase()) {

      case 'microsoft_mit':
        return `${h.microsoft}\n${h.mit}\n${h.default.replace('{core}', version)}\n${h.warning}`;

      case 'microsoft_apache':
        return `${h.microsoft}\n${h.apache}\n${h.default.replace('{core}', version)}\n${h.warning}`;

      case 'microsoft_mit_no_version':
        return `${h.microsoft}\n${h.mit}\n${h['no-version']}\n${h.warning}`;

      case 'microsoft_apache_no_version':
        return `${h.microsoft}\n${h.apache}\n${h['no-version']}${h.warning}`;

      case 'microsoft_apache_no_codegen':
        return `${h.microsoft}\n${h.mit}\n${h['no-version']}`;

      case 'none':
        return '';

      case 'microsoft_mit_small':
        return `${h.microsoft}\n${h['mit-small']}\n${h.default.replace('{core}', version)}\n${h.warning}`;

      case 'microsoft_mit_small_no_codegen':
        return `${h.microsoft}\n${h['mit-small']}\n${h['no-version']}`;

      case null:
      case undefined:
        return `${h.default.replace('{core}', version)}\n${h.warning}`;

      default:
        return `${this.rawConfig['license-header']}`;
    }
  }

  public IsOutputArtifactRequested(artifact: string): boolean {
    return From(valuesOf<string>(this.config['output-artifact'])).Contains(artifact);
  }

  public GetEntry(key: string): any {
    if (!key) {
      return clone(this.config);
    }
    if (key === 'resolved-directive') {
      return this.resolveDirectives();
    }
    if (<any>key === 'header-text') {
      return this.HeaderText;
    }
    let result = <any>this.config;
    for (const keyPart of key.split('.')) {
      result = result[keyPart];
    }
    return result;
  }

  public get Raw(): AutoRestConfigurationImpl {
    return this.config;
  }

  public get DebugMode(): boolean {
    return !!this.config['debug'];
  }

  public get CacheMode(): boolean {
    return !!this.config['cache'];
  }

  public get CacheExclude(): Array<string> {
    const cache = this.config['cache'];
    if (cache && cache.exclude) {
      return [...valuesOf<string>(cache.exclude)];
    }
    return [];
  }

  public get VerboseMode(): boolean {
    return !!this.config['verbose'];
  }

  public get HelpRequested(): boolean {
    return !!this.config['help'];
  }

  public * GetNestedConfiguration(pluginName: string): Iterable<ConfigurationView> {
    const pp = pluginName.split('.');
    if (pp.length > 1) {
      const n = this.GetNestedConfiguration(pp[0]);
      for (const s of n) {
        yield* s.GetNestedConfiguration(pp.slice(1).join('.'));
      }
      return;
    }

    for (const section of valuesOf<any>((<any>this.config)[pluginName])) {
      if (section) {
        yield this.GetNestedConfigurationImmediate(section === true ? {} : section);
      }
    }
  }

  public GetNestedConfigurationImmediate(...scope: Array<any>): ConfigurationView {
    return new ConfigurationView(this.configurationFiles, this.fileSystem, this.messageEmitter, this.configFileFolderUri, ...scope, this.config).Indexer;
  }

  // message pipeline (source map resolution, filter, ...)
  public async Message(m: Message): Promise<void> {
    if (m.Channel === Channel.Debug && !this.DebugMode) {
      return;
    }

    if (m.Channel === Channel.Verbose && !this.VerboseMode) {
      return;
    }

    try {
      // update source locations to point to loaded Swagger
      if (m.Source && typeof (m.Source.map) === 'function') {
        const blameSources = m.Source.map(async s => {
          let blameTree: BlameTree | null = null;

          try {
            const originalPath = JSON.stringify(s.Position.path);
            let shouldComplain = false;
            while (blameTree === null) {
              try {
                blameTree = await this.DataStore.Blame(s.document, s.Position);
                if (shouldComplain) {
                  this.Message({
                    Channel: Channel.Verbose,
                    Text: `\nDEVELOPER-WARNING: Path '${originalPath}' was corrected to ${JSON.stringify(s.Position.path)} on MESSAGE '${JSON.stringify(m.Text)}'\n`
                  });
                }
              } catch (e) {
                if (!shouldComplain) {
                  shouldComplain = true;
                }
                const path = <Array<string>>s.Position.path;
                if (path) {
                  if (path.length === 0) {
                    throw e;
                  }
                  // adjustment
                  // 1) skip leading `$`
                  if (path[0] === '$') {
                    path.shift();
                  } else {
                    path.pop();
                  }
                } else {
                  throw e;
                }
              }
            }
          } catch (e) {

            /*
              GS01: This should be restored when we go 'release'

            this.Message({
              Channel: Channel.Warning,
              Text: `Failed to blame ${JSON.stringify(s.Position)} in '${JSON.stringify(s.document)}' (${e})`,
              Details: e
            });
            */
            return [s];
          }

          return blameTree.BlameLeafs().map(r => <SourceLocation>{ document: r.source, Position: { ...TryDecodeEnhancedPositionFromName(r.name), line: r.line, column: r.column } });
        });

        const src = From(await Promise.all(blameSources)).SelectMany(x => x).ToArray();
        m.Source = src;
        // m.Source = From(blameSources).SelectMany(x => x).ToArray();
        // get friendly names
        for (const source of src) {
          if (source.Position) {
            try {
              source.document = this.DataStore.ReadStrictSync(source.document).Description;
            } catch {
              // no worries
            }
          }
        }
      }

      // set range (dummy)
      if (m.Source && typeof (m.Source.map) === 'function') {
        m.Range = m.Source.map(s => {
          const positionStart = s.Position;
          const positionEnd = <sourceMap.Position>{ line: s.Position.line, column: s.Position.column + (s.Position.length || 3) };

          return <Range>{
            document: s.document,
            start: positionStart,
            end: positionEnd
          };
        });
      }

      // filter
      const mx = this.suppressor.filter(m);

      // forward
      if (mx !== null) {
        // format message
        switch (this.GetEntry('message-format')) {
          case 'json':
            // TODO: WHAT THE FUDGE, check with the consumers whether this has to be like that... otherwise, consider changing the format to something less generic
            if (mx.Details) {
              mx.Details.sources = (mx.Source || []).filter(x => x.Position).map(source => {
                let text = `${source.document}:${source.Position.line}:${source.Position.column}`;
                if (source.Position.path) {
                  text += ` (${stringify(source.Position.path)})`;
                }
                return text;
              });
              if (mx.Details.sources.length > 0) {
                mx.Details['jsonref'] = mx.Details.sources[0];
                mx.Details['json-path'] = mx.Details.sources[0];
              }
            }
            mx.FormattedMessage = JSON.stringify(mx.Details || mx, null, 2);
            break;
          case 'yaml':
            mx.FormattedMessage = Stringify([mx.Details || mx]).replace(/^---/, '');
            break;
          default: {
            const t = mx.Channel === Channel.Debug || mx.Channel === Channel.Verbose ? ` [${Math.floor(process.uptime() * 100) / 100} s]` : '';
            let text = `${(mx.Channel || Channel.Information).toString().toUpperCase()}${mx.Key ? ` (${[...mx.Key].join('/')})` : ''}${t}: ${mx.Text}`;
            for (const source of mx.Source || []) {
              if (source.Position) {
                try {
                  text += `\n    - ${source.document}`;
                  if (source.Position.line !== undefined) {
                    text += `:${source.Position.line}`;
                    if (source.Position.column !== undefined) {
                      text += `:${source.Position.column}`;
                    }
                  }
                  if (source.Position.path) {
                    text += ` (${stringify(source.Position.path)})`;
                  }
                } catch (e) {
                  // no friendly name, so nothing more specific to show
                }
              }
            }
            mx.FormattedMessage = text;
            break;
          }
        }
        this.messageEmitter.Message.Dispatch(mx);
      }
    } catch (e) {
      this.messageEmitter.Message.Dispatch({ Channel: Channel.Error, Text: `${e}` });
    }
  }
}

export class Configuration {
  public constructor(
    private fileSystem: IFileSystem = new RealFileSystem(),
    private configFileOrFolderUri?: string,
  ) { }

  private async ParseCodeBlocks(configFile: DataHandle, contextConfig: ConfigurationView, scope: string): Promise<Array<AutoRestConfigurationImpl>> {
    // load config
    const hConfig = await parseCodeBlocks(
      contextConfig,
      configFile,
      contextConfig.DataStore.getDataSink());

    if (hConfig.length === 1 && hConfig[0].info === null && configFile.Description.toLowerCase().endsWith('.md')) {
      // this is a whole file, and it's a markdown file.
      return [];
    }

    const blocks = await Promise.all(hConfig.filter(each => each).map(each => {
      const pBlock = each.data.ReadObject<AutoRestConfigurationImpl>();
      return pBlock.then(block => {
        if (!block) {
          block = {};
        }
        if (typeof block !== 'object') {
          contextConfig.Message({
            Channel: Channel.Error,
            Text: 'Syntax error: Invalid YAML object.',
            Source: [<SourceLocation>{ document: each.data.key, Position: { line: 1, column: 0 } }]
          });
          throw new OperationAbortedException();
        }
        block.__info = each.info;
        return block;
      });

    }));
    return blocks;
  }

  private static extensionManager: LazyPromise<ExtensionManager> = new LazyPromise<ExtensionManager>(() => ExtensionManager.Create(join(process.env['autorest.home'] || require('os').homedir(), '.autorest')));

  private async DesugarRawConfig(configs: any): Promise<any> {
    // shallow copy
    configs = { ...configs };
    configs['use-extension'] = { ...configs['use-extension'] };

    if (configs['licence-header']) {
      configs['license-header'] = configs['licence-header'];
      delete configs['licence-header'];
    }

    // use => use-extension
    let use = configs.use;
    if (typeof use === 'string') {
      use = [use];
    }
    if (Array.isArray(use)) {
      const extMgr = await Configuration.extensionManager;
      for (const useEntry of use) {
        if (typeof useEntry === 'string') {
          // potential formats:
          // <pkg>
          // <pkg>@<version>
          // @<org>/<pkg>
          // @<org>/<pkg>@<version>
          // <path>
          // <path/uri to .tgz package file>
          // if the entry starts with an @ it's definitely a package reference
          if (useEntry.endsWith('.tgz') || await isDirectory(useEntry)) {
            const pkg = await extMgr.findPackage('plugin', useEntry);
            configs['use-extension'][pkg.name] = useEntry;
          } else {
            const [, identity, version] = <RegExpExecArray>/(^@.*?\/[^@]*|[^@]*)@?(.*)/.exec(useEntry);
            if (identity) {
              // parsed correctly
              if (version) {
                const pkg = await extMgr.findPackage(identity, version);
                configs['use-extension'][pkg.name] = version;
              } else {
                // it's either a location or just the name
                if (IsUri(identity) || await exists(identity)) {
                  // seems like it's a location to something. we don't know the actual name at this point.
                  const pkg = await extMgr.findPackage('plugin', identity);
                  configs['use-extension'][pkg.name] = identity;
                } else {
                  // must be a package name without a version
                  // assume *?
                  const pkg = await extMgr.findPackage(identity, '*');
                  configs['use-extension'][pkg.name] = pkg.version;
                }
              }
            }
          }
        }
      }
      delete configs.use;
    }
    return configs;
  }

  private async desugarRawConfigs(configs: Array<any>): Promise<Array<any>> {
    return Promise.all(configs.map(c => this.DesugarRawConfig(c)));
  }

  public static async shutdown() {
    try {
      AutoRestExtension.killAll();

      // once we shutdown those extensions, we should shutdown the EM too.
      const extMgr = await Configuration.extensionManager;
      extMgr.dispose();

      // but if someone goes to use that, we're going to need a new instance (since the shared lock will be gone in the one we disposed.)
      Configuration.extensionManager = new LazyPromise<ExtensionManager>(() => ExtensionManager.Create(join(process.env['autorest.home'] || require('os').homedir(), '.autorest')));

      for (const each in loadedExtensions) {
        const ext = loadedExtensions[each];
        if (ext.autorestExtension.hasValue) {
          const extension = await ext.autorestExtension;
          extension.kill();
          delete loadedExtensions[each];
        }
      }
    } catch {
      // no worries
    }
  }

  public async CreateView(messageEmitter: MessageEmitter, includeDefault: boolean, ...configs: Array<any>): Promise<ConfigurationView> {
    const configFileUri = this.fileSystem && this.configFileOrFolderUri
      ? await Configuration.DetectConfigurationFile(this.fileSystem, this.configFileOrFolderUri, messageEmitter)
      : null;
    const configFileFolderUri = configFileUri ? ResolveUri(configFileUri, './') : (this.configFileOrFolderUri || 'file:///');

    const configurationFiles: { [key: string]: any } = {};
    const configSegments: Array<any> = [];
    const secondPass: Array<any> = [];

    const createView = (segments: Array<any> = configSegments) => {
      return new ConfigurationView(configurationFiles, this.fileSystem, messageEmitter, configFileFolderUri, ...segments);
    };
    const addSegments = async (configs: Array<any>, keepInSecondPass = true): Promise<Array<any>> => {
      const segs = await this.desugarRawConfigs(configs);
      configSegments.push(...segs);
      if (keepInSecondPass) {
        secondPass.push(...segs);
      }
      return segs;
    };
    const fsInputView = messageEmitter.DataStore.GetReadThroughScope(this.fileSystem);

    // 1. overrides (CLI, ...)
    await addSegments(configs, false);
    // 2. file
    if (configFileUri !== null) {
      // add loaded files to the input files.
      messageEmitter.Message.Dispatch({
        Channel: Channel.Verbose,
        Text: `> Initial configuration file '${configFileUri}'`
      });
      configurationFiles[configFileUri] = await (await fsInputView.ReadStrict(configFileUri)).ReadData();

      const blocks = await this.ParseCodeBlocks(
        await fsInputView.ReadStrict(configFileUri),
        createView(),
        'config');
      await addSegments(blocks, false);
    }

    // 3. resolve 'require'd configuration
    const addedConfigs = new Set<string>();
    const includeFn = async (fsToUse: IFileSystem) => {

      for await (let additionalConfig of ConfigurationView.getIncludedConfigurationFiles(createView, fsToUse, addedConfigs)) {
        // acquire additional configs
        try {
          additionalConfig = simplifyUri(additionalConfig);

          // skip ones we've aleady loaded faster.
          if (configurationFiles[additionalConfig]) {
            continue;
          }

          messageEmitter.Message.Dispatch({
            Channel: Channel.Verbose,
            Text: `> Including configuration file '${additionalConfig}'`
          });
          addedConfigs.add(additionalConfig);
          // merge config

          const inputView = messageEmitter.DataStore.GetReadThroughScope(fsToUse);

          configurationFiles[additionalConfig] = await (await inputView.ReadStrict(additionalConfig)).ReadData();
          const blocks = await this.ParseCodeBlocks(
            await inputView.ReadStrict(additionalConfig),
            createView(),
            `require-config-${additionalConfig}`);
          await addSegments(blocks);
        } catch (e) {
          messageEmitter.Message.Dispatch({
            Channel: Channel.Fatal,
            Text: `Failed to acquire 'require'd configuration '${additionalConfig}'`
          });
          throw e;
        }
      }
    };
    await includeFn(this.fileSystem);

    // 4. default configuration
    const fsLocal = new RealFileSystem();
    if (includeDefault) {
      const inputView = messageEmitter.DataStore.GetReadThroughScope(fsLocal);
      const blocks = await this.ParseCodeBlocks(
        await inputView.ReadStrict(ResolveUri(CreateFolderUri(__dirname), '../../resources/default-configuration.md')),
        createView(),
        'default-config');
      await addSegments(blocks);
    }

    await includeFn(fsLocal);
    const messageFormat = createView().GetEntry('message-format');

    // 5. resolve extensions
    const extMgr = await Configuration.extensionManager;
    const addedExtensions = new Set<string>();


    const resolveExtensions = async () => {
      const viewsToHandle: Array<ConfigurationView> = [createView()];
      while (viewsToHandle.length > 0) {
        const tmpView = <ConfigurationView>viewsToHandle.pop();
        const additionalExtensions = tmpView.UseExtensions.filter(ext => !addedExtensions.has(ext.fullyQualified));
        await addSegments([{ 'used-extension': tmpView.UseExtensions.map(x => x.fullyQualified) }]);
        if (additionalExtensions.length === 0) {
          continue;
        }
        // acquire additional extensions
        for (const additionalExtension of additionalExtensions) {
          try {
            addedExtensions.add(additionalExtension.fullyQualified);

            let ext = loadedExtensions[additionalExtension.fullyQualified];

            // not yet loaded?
            if (!ext) {
              let localPath = untildify(additionalExtension.source);

              // try resolving the package locally (useful for self-contained)
              try {
                const fileProbe = '/package.json';
                localPath = require.resolve(additionalExtension.name + fileProbe); // have to resolve specific file - resolving a package by name will fail if no 'main' is present
                localPath = localPath.slice(0, localPath.length - fileProbe.length);
              } catch {
                // no worries
              }


              // trim off the '@org' and 'autorest.' from the name.
              const shortname = additionalExtension.name.split('/').last.replace(/^autorest\./ig, '');
              const view = [...createView().GetNestedConfiguration(shortname)];
              const enableDebugger = view.length > 0 ? <boolean>(view[0].GetEntry('debugger')) : false;

              if (await exists(localPath) && !localPath.endsWith('.tgz')) {
                localPath = filePath(localPath);
                if (messageFormat !== 'json' && messageFormat !== 'yaml') {
                  // local package
                  messageEmitter.Message.Dispatch({
                    Channel: Channel.Information,
                    Text: `> Loading local AutoRest extension '${additionalExtension.name}' (${localPath})`
                  });
                }

                const pack = await extMgr.findPackage(additionalExtension.name, localPath);
                const extension = new LocalExtension(pack, localPath);

                // start extension
                ext = loadedExtensions[additionalExtension.fullyQualified] = {
                  extension,
                  autorestExtension: new LazyPromise(async () => AutoRestExtension.FromChildProcess(additionalExtension.name, await extension.start(enableDebugger)))
                };
              } else {
                // remote package`
                const installedExtension = await extMgr.getInstalledExtension(additionalExtension.name, additionalExtension.source);
                if (installedExtension) {
                  if (messageFormat !== 'json' && messageFormat !== 'yaml') {
                    messageEmitter.Message.Dispatch({
                      Channel: Channel.Information,
                      Text: `> Loading AutoRest extension '${additionalExtension.name}' (${additionalExtension.source}->${installedExtension.version})`
                    });
                  }

                  // start extension
                  ext = loadedExtensions[additionalExtension.fullyQualified] = {
                    extension: installedExtension,
                    autorestExtension: new LazyPromise(async () => AutoRestExtension.FromChildProcess(additionalExtension.name, await installedExtension.start(enableDebugger)))
                  };
                } else {
                  // acquire extension
                  const pack = await extMgr.findPackage(additionalExtension.name, additionalExtension.source);
                  messageEmitter.Message.Dispatch({
                    Channel: Channel.Information,
                    Text: `> Installing AutoRest extension '${additionalExtension.name}' (${additionalExtension.source})`
                  });
                  const cwd = process.cwd(); // TODO: fix extension?
                  const extension = await extMgr.installPackage(pack, false, 5 * 60 * 1000, (progressInit: any) => progressInit.Message.Subscribe((s: any, m: any) => tmpView.Message({ Text: m, Channel: Channel.Verbose })));
                  messageEmitter.Message.Dispatch({
                    Channel: Channel.Information,
                    Text: `> Installed AutoRest extension '${additionalExtension.name}' (${additionalExtension.source}->${extension.version})`
                  });
                  process.chdir(cwd);
                  // start extension

                  ext = loadedExtensions[additionalExtension.fullyQualified] = {
                    extension,
                    autorestExtension: new LazyPromise(async () => AutoRestExtension.FromChildProcess(additionalExtension.name, await extension.start(enableDebugger)))
                  };
                }
              }
            }
            await includeFn(fsLocal);

            // merge config from extension
            const inputView = messageEmitter.DataStore.GetReadThroughScope(new RealFileSystem());

            const cp = simplifyUri(CreateFileUri(await ext.extension.configurationPath));
            messageEmitter.Message.Dispatch({
              Channel: Channel.Verbose,
              Text: `> Including extension configuration file '${cp}'`
            });

            const blocks = await this.ParseCodeBlocks(
              await inputView.ReadStrict(cp),
              createView(),
              `extension-config-${additionalExtension.fullyQualified}`);
            // even though we load extensions after the default configuration, I want them to be able to 
            // trigger changes in the default configuration loading (ie, an extension can set a flag to use a different pipeline.)
            viewsToHandle.push(createView(await addSegments(blocks.map(each => each['pipeline-model'] ? ({ ...each, 'load-priority': 1000 }) : each))));
          } catch (e) {
            messageEmitter.Message.Dispatch({
              Channel: Channel.Fatal,
              Text: `Failed to install or start extension '${additionalExtension.name}' (${additionalExtension.source})`
            });
            throw e;
          }
        }
        await includeFn(fsLocal);
      }

      // resolve any outstanding includes again
      await includeFn(fsLocal);
    };

    // resolve the extensions
    await resolveExtensions();

    // re-acquire CLI and configuration files at a lower priority
    // this enables the configuration of a plugin to specify stuff like `pipeline-model`
    // which would unlock a guarded section that has $(pipeline-model) == 'v3' in the yaml block.
    // doing so would allow the configuration to load input-files that have that guard on

    // and because this comes in at a lower-priority, it won't overwrite values that have been already
    // set in a meaningful way.

    // it's only marginally hackey...

    // reload files
    if (configFileUri !== null) {
      const blocks = await this.ParseCodeBlocks(
        await fsInputView.ReadStrict(configFileUri),
        createView(),
        'config');
      await addSegments(blocks, false);
      await includeFn(this.fileSystem);
      await resolveExtensions();
      return createView([...configs, ...blocks, ...secondPass]).Indexer;
    }
    await resolveExtensions();
    // return the final view 
    return createView().Indexer;
  }
  public static async DetectConfigurationFile(fileSystem: IFileSystem, configFileOrFolderUri: string | null, messageEmitter?: MessageEmitter, walkUpFolders = false): Promise<string | null> {
    const files = await this.DetectConfigurationFiles(fileSystem, configFileOrFolderUri, messageEmitter, walkUpFolders);

    return From<string>(files).FirstOrDefault(each => each.toLowerCase().endsWith('/' + Constants.DefaultConfiguration)) ||
      From<string>(files).OrderBy(each => each.length).FirstOrDefault() || null;
  }

  public static async DetectConfigurationFiles(fileSystem: IFileSystem, configFileOrFolderUri: string | null, messageEmitter?: MessageEmitter, walkUpFolders = false): Promise<Array<string>> {
    const originalConfigFileOrFolderUri = configFileOrFolderUri;

    // null means null!
    if (!configFileOrFolderUri) {
      return [];
    }

    // try querying the Uri directly
    let content: string | null;
    try {
      content = await fileSystem.ReadFile(configFileOrFolderUri);
    } catch {
      // didn't get the file successfully, move on.
      content = null;
    }
    if (content !== null) {
      if (content.indexOf(Constants.MagicString) > -1) {
        // the file name was passed in!
        return [configFileOrFolderUri];
      }
      try {
        const ast = ParseToAst(content);
        if (ast) {
          return [configFileOrFolderUri];
        }
      } catch {
        // nope.
      }
      // this *was* an actual file passed in, not a folder. don't make this harder than it has to be.
      throw new Error(`Specified file '${originalConfigFileOrFolderUri}' is not a valid configuration file (missing magic string, see https://github.com/Azure/autorest/blob/master/docs/user/literate-file-formats/configuration.md#the-file-format).`);
    }

    // scan the filesystem items for configurations.
    const results = new Array<string>();
    for (const name of await fileSystem.EnumerateFileUris(EnsureIsFolderUri(configFileOrFolderUri))) {
      if (name.endsWith('.md')) {
        const content = await fileSystem.ReadFile(name);
        if (content.indexOf(Constants.MagicString) > -1) {
          results.push(name);
        }
      }
    }

    if (walkUpFolders) {
      // walk up
      const newUriToConfigFileOrWorkingFolder = ResolveUri(configFileOrFolderUri, '..');
      if (newUriToConfigFileOrWorkingFolder !== configFileOrFolderUri) {
        results.push(... await this.DetectConfigurationFiles(fileSystem, newUriToConfigFileOrWorkingFolder, messageEmitter, walkUpFolders));
      }
    } else {
      if (messageEmitter && results.length === 0) {
        messageEmitter.Message.Dispatch({
          Channel: Channel.Verbose,
          Text: `No configuration found at '${originalConfigFileOrFolderUri}'.`
        });
      }
    }

    return results;
  }
}
