/* Module: Logger -- Event logging for environments and modules; log searches. */

var Module = require('./Module.js');
var winston = require('winston');
var moment = require('moment');
var fs = require('fs');
var cp = require('child_process');

class ModLogger extends Module {

    
    get requiredParams() { return [
        'basePath',             //Path to the logs directory
        'logs'                  //List of: {outputFile: TEMPLATE, channels: [LOGCHANNEL, ...]} where the outputFiles are moment templates relative to basePath (must end in .log)
    ]; }
    
    get optionalParams() { return [
        'templateJoin',         //Template for join event logs. Placeholders: %(MOMENT_FORMAT)% %env% %userid% %channelid%
        'templatePart',         //Template for part event logs. Placeholders: %(MOMENT_FORMAT)% %env% %userid% %channelid% %reason%
        'templateMessage',      //Template for message event logs. Placeholders: %(MOMENT_FORMAT)% %env% %userid% %channelid% %type% %message%
        'maxResults'            //Maximum results per search
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('Logger', name);
        
        this._params['templateJoin'] = '%(YYYY-MM-DD HH:mm:ss)% {%env%} [%channelid%] * Joins: %userid%';
        this._params['templatePart'] = '%(YYYY-MM-DD HH:mm:ss)% {%env%} [%channelid%] * Parts: %userid% (%reason%)';
        this._params['templateMessage'] = '%(YYYY-MM-DD HH:mm:ss)% {%env%} [%channelid%] <%userid%> %message%';
        this._params['maxResults'] = 5;
        
        this._logs = [];  //Initialized with param('logs') but each item also contains logger (points to winston logger).
        this._channels = {};        
    }
    
    
    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;


        //Index channels
        
        this._logs = this.params('logs');
        for (let log of this._logs) {
            if (!log.outputFile || !log.outputFile.match(/\.log$/)) continue;
            if (log.channels || log.channels.length) continue;
            
            log.logger = null;
            log.openPath = null;
            
            for (let channel of log.channels) {
                if (!this._channels[channel]) {
                    this._channels[channel] = [];
                }
                this._channels[channel].push(log);
            }
        }

      
        //Register callbacks
        
        for (var envname in envs) {
            envs[envname].registerOnJoin(this.onJoin, this);
            envs[envname].registerOnPart(this.onPart, this);
            envs[envname].registerOnMessage(this.onMessage, this);
        }
        
        
        this.mod('Commands').registerCommand('grep', {
            description: "Search the event logs.",
            args: ["pattern", "results", "filepattern"],
            minArgs: 1,
            permissions: ["administrator", "moderator", "trusted"]
        }, (env, type, userid, command, args, handle, reply) => {
        
            var filepattern = null;
            if (args.filepattern) {
                filepattern = args.filepattern;
                if (!filepattern.match(/^\/.*\/$/)) {
                    filepattern = '/^' + filepattern.replace(/ /, '.*') + '$/';
                }
                filepattern = RegExp(filepattern);
            }
            
            var pattern = args.pattern;
            if (!pattern.match(/^\/.*\/$/)) {
                pattern = '/^' + pattern.replace(/ /, '.*') + '$/';
            }
            
            var maxResults = this.param('maxResults');
            if (args.results) maxResults = Math.min(maxResults, args.results);
        
            var results = 0;
        
            for (let logpath of this.getLogPaths(filepattern)) {

                let lines = cp.execSync('grep -P ' + pattern + ' "' + logpath + '"');
                lines = lines.split("\n");

                for (let line of lines) {
                    if (!line.trim()) continue;
                
                    reply('  ' + line);
                
                    results += 1;
                    if (maxResults && results >= maxResults) break;
                }
                    
                if (maxResults && results >= maxResults) break;
            }
            
            if (results) {
                reply('Found ' + results + ' result' + (results != 1 ? 's' : '') + (results == maxResults ? ' (max)' : '') + '.');
            } else {
                reply('Found nothing.');
            }
        
            return true;
        });
      
        return true;
    };
    
    
    // # Module code below this line #
    
    
    //Write to log; call this from dependent modules to log custom events
    
    write(logchannel, message) {
        if (!logchannel) return 0;
        
        var writes = 0;
        for (let log of this._channels[logchannel]) {
            
            if (!this.ready(log)) {
                if (!log.warned) {
                    this.log('warning', 'Unable to open event log with template "' + log.outputFile + '" for channel "' + logchannel + '".');
                    log.warned = true;
                }
                continue;
            }
        
            log.logger.info(message);
            writes += 1;
        }
        
        return writes;
    }
    
    
    //Write to log using a template and placeholder values
    
    templateWrite(logchannel, template, fields) {
        if (!fields) fields = {};
        if (!template) template = "";
        var message = template;
        
        message.replace(/%\(([^)]+)\)%/g, (match, format) => {
            return moment().format(format);
        });
        
        message.replace(/%([^%]+)%/g, (match, placeholder) => {
            if (fields[placeholder]) return fields[placeholder];
            return "";
        });
        
        return this.write(logchannel, message);
    }
    
    
    //Write to log using a template informally defined in this module's config; call from dependent modules if desired
    
    templateNameWrite(logchannel, templatename, fields) {
        if (!templatename) return false;
        
        var param = 'template' + templatename.charAt(0).toUpperCase() + templatename.slice(1);
        if (!this.param(param)) return false;
        
        return this.templateWrite(logchannel, this.param(param), fields);
    }
    
    
    //Event handlers
    
    onJoin(env, authorid, channelid, rawobj) {
        return this.templateWrite("join", this.param("templateJoin"), {env: env.name, userid: authorid, channelid: channelid});
    }
    
    
    onPart(env, authorid, channelid, reason, rawobj) {
        return this.templateWrite("part", this.param("templatePart"), {env: env.name, userid: authorid, channelid: channelid, reason: reason});
    }
    
    
    onMessage(env, type, message, authorid, channelid, rawobj) {
        var channel = 'default';
        if (type == "regular" || type == "action") channel = 'public';
        if (type == "private" || type == "privateaction") channel = 'private';
        return this.templateWrite(channel, this.param("templateMessage"), {env: env.name, userid: authorid, channelid: channelid, type: type, message: env.normalizeFormatting(message)});
    }
    
    
    //Auxiliary - Open or reopen a logger
    
    ready(log) {
        if (!log.outputFile) return false;
        
        var desiredPath = this.param('basePath') + moment().format(log.outputFile);
        if (!log.logger || log.openPath != desiredPath) {
            log.openPath = desiredPath;
            this.log('Log open: ' + desiredPath);

            log.logger = new (winston.Logger)({
                transports: [
                    new (winston.transports.File)({
                        filename: log.openPath,
                        json: false,
                        timestamp: () => "",
                        prettyPrint: true,
                        formatter: (args) => args.message
                    })
                ]
            });
        }
        
        return !!log.logger;
    }
    
    
    //Auxiliary - List existing log files
    
    getLogPaths(filter) {
        var result = [];
        var paths = [this.params('basePath')];
        while (let path = paths.shift()) {
            for (let file of fs.readdirSync(path)) {
                if (file.match(/^\./)) continue;
                let filepath = path + '/' + file;
                if (filter && !filter.exec(filepath)) continue;
                if (fs.statSync(filepath).isDirectory()) {
                    paths.push(filepath);
                } else if (file.match(/\.log$/)) {
                    result.push(filepath);
                }
            }
        }
        return result;        
    };
    

}


module.exports = ModLogger;
