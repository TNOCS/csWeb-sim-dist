var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var fs = require('fs');
var path = require('path');
var Winston = require('winston');
var csweb = require('csweb');
var SimSvc = require('../../SimulationService/api/SimServiceManager');
var _ = require('underscore');
/**
 * Flooding Simulator.
 *
 * FloodSim does not calculate a flooding, but listens for flooding start events (at a certain time and location),
 * and from then on publishes the water depth.
 *
 * FloodSim is fed with a number of scenarios, i.e. known flooding simulations consisting of a sequence of
 * raster files which contain the maximum water depth for a certain breach location at a certain time
 * (defined from the start of the flooding).
 *
 * Each scenario has its own folder in the 'data/flooding' folder. The folder contains files, where the filename of
 * each file is the time in minutes since the flooding started.
 *
 * Based on the received trigger, it will publish a selected scenario.
 *
 * TOOD
 * Add a REST interface to inform others what kinds of keys / messages you expect, and what you need.
 */
var FloodSim = (function (_super) {
    __extends(FloodSim, _super);
    function FloodSim(namespace, name, isClient, options) {
        var _this = this;
        if (isClient === void 0) { isClient = false; }
        if (options === void 0) { options = {}; }
        _super.call(this, namespace, name, isClient, options);
        this.isClient = isClient;
        this.options = options;
        /** Relative folder for the scenarios */
        this.sourceFolder = '';
        /** Base folder for the scenarios */
        this.scenarioFolder = 'scenarios';
        /** If true, the flooding has started */
        this.floodingHasStarted = false;
        /** A list of available flood simulations, i.e. floodSims[scenarioName] = { timeStamp, layer } */
        this.floodSims = {};
        this.subscribeKey('sim.floodSimCmd', {}, function (topic, message, params) {
            Winston.info("Topic: " + topic + ", Msg: " + JSON.stringify(message, null, 2) + ", Params: " + (params ? JSON.stringify(params, null, 2) : '-') + ".");
            if (message.hasOwnProperty('scenario'))
                _this.startScenario(message['scenario']);
            if (message.hasOwnProperty('next'))
                _this.publishNextFloodLayer(Number.MAX_VALUE);
        });
        // When the simulation time is changed:
        // 1. Check if we have to publish a new Layer
        // 2. If there is a new layer, read the asc grid file and put it in the layer.data property
        this.on('simTimeChanged', function () {
            var scenario = _this.pubFloodingScenario.scenario;
            if (!scenario || !_this.floodSims.hasOwnProperty(scenario))
                return;
            if (_this.floodSims[scenario][_this.floodSims[scenario].length - 1].timeStamp === _this.pubFloodingScenario.timeStamp) {
                _this.message = scenario + " scenario has ended.";
                _this.nextEvent = null;
                _this.sendAck(_this.fsm.currentState);
                return;
            }
            var minutesSinceStart = _this.simTime.diffMinutes(_this.pubFloodingScenario.startTime);
            _this.publishNextFloodLayer(minutesSinceStart);
        });
    }
    FloodSim.prototype.start = function (sourceFolder) {
        _super.prototype.start.call(this);
        this.sourceFolder = sourceFolder;
        this.reset();
        this.initFSM();
        this.loadAllScenarioFiles();
    };
    FloodSim.prototype.reset = function () {
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/layers'));
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/keys'));
        this.publishFloodLayer();
        this.fsm.currentState = SimSvc.SimState.Ready;
        this.sendAck(this.fsm.currentState);
    };
    /**
     * Initialize the FSM.
     */
    FloodSim.prototype.initFSM = function () {
        var _this = this;
        this.fsm.onEnter(SimSvc.SimState.Idle, function (from) {
            _this.message = 'Scenario has been reset.';
            _this.reset();
            return true;
        });
    };
    /**
     * Create and publish the flood layer.
     */
    FloodSim.prototype.publishFloodLayer = function () {
        var layer = this.createNewFloodLayer("", 'Initial flooding status.');
        this.pubFloodingScenario = {
            scenario: '',
            timeStamp: -1,
            startTime: null,
            layer: layer
        };
        this.addUpdateLayer(layer, {}, function () { });
    };
    FloodSim.prototype.createNewFloodLayer = function (file, description) {
        var layer = {
            server: this.options.server,
            id: 'FloodSim',
            title: 'Flooding',
            description: description,
            features: [],
            storage: 'file',
            enabled: true,
            isDynamic: true,
            data: '',
            url: file,
            typeUrl: this.options.server + "/api/resources/floodsimtypes",
            type: 'grid',
            renderType: 'gridlayer',
            dataSourceParameters: {
                propertyName: 'h',
                gridType: 'esri',
                projection: 'WGS84',
                legendStringFormat: '{0:0.00}m'
            },
            defaultFeatureType: 'flooding',
            defaultLegendProperty: 'h'
        };
        return layer;
    };
    /**
     * Load all the scenarios and all flooding simulations.
     */
    FloodSim.prototype.loadAllScenarioFiles = function () {
        var _this = this;
        this.floodSims = {};
        // Read scenarios from the folder
        this.scenarioFolder = path.join(this.sourceFolder);
        if (!fs.existsSync(this.scenarioFolder))
            return;
        // Start loading all data
        var scenarios = csweb.getDirectories(this.scenarioFolder);
        scenarios.forEach(function (scenario) {
            var scenarioFolder = path.join(_this.scenarioFolder, scenario);
            var files = fs.readdirSync(scenarioFolder);
            files.forEach(function (f) {
                var ext = path.extname(f);
                var file = path.join(scenarioFolder, f);
                if (ext !== '.asc')
                    return;
                _this.addToScenarios(scenario, file);
            });
        });
    };
    FloodSim.prototype.addToScenarios = function (scenario, file) {
        var timeStamp = this.extractTimeStamp(path.basename(file));
        var layer = this.createNewFloodLayer(file, "Flooding " + scenario + ": situation after " + timeStamp + " minutes.");
        if (!this.floodSims.hasOwnProperty(scenario))
            this.floodSims[scenario] = [];
        this.floodSims[scenario].push({
            timeStamp: timeStamp,
            layer: layer
        });
        // Sort files on every insertion, so we process them in the right sequence too.
        this.floodSims[scenario].sort(function (a, b) {
            return (a.timeStamp < b.timeStamp) ? -1 : 1;
        });
    };
    /** Publish the next available flooding layer. */
    FloodSim.prototype.publishNextFloodLayer = function (minutesSinceStart) {
        var _this = this;
        var scenario = this.pubFloodingScenario.scenario;
        var publishedTimeStamp = this.pubFloodingScenario.timeStamp;
        this.fsm.trigger(SimSvc.SimCommand.Run);
        Winston.info("Start time: " + this.pubFloodingScenario.startTime.toLocaleTimeString() + ".");
        Winston.info("Current time: " + this.simTime.toLocaleTimeString() + ".");
        Winston.info("Minutes since start: " + minutesSinceStart + ".");
        for (var i in this.floodSims[scenario]) {
            var s = this.floodSims[scenario][i];
            if (s.timeStamp <= publishedTimeStamp)
                continue;
            if (s.timeStamp > minutesSinceStart) {
                this.fsm.trigger(SimSvc.SimCommand.Finish);
                return;
            }
            this.pubFloodingScenario.timeStamp = s.timeStamp;
            var keys = Object.keys(this.floodSims[scenario]);
            var index = keys.indexOf(i);
            var nextFlood = this.floodSims[scenario][keys[index + 1]];
            Winston.warn("nextFlood: " + nextFlood.timeStamp);
            this.nextEvent = (nextFlood) ? (this.pubFloodingScenario.startTime.addMinutes(nextFlood.timeStamp)).getTime() : null;
            fs.readFile(s.layer.url, 'utf8', function (err, data) {
                if (err) {
                    Winston.error("Error reading file: " + err + ".");
                    _this.fsm.trigger(SimSvc.SimCommand.Finish);
                    return;
                }
                _this.message = scenario + ": minute " + s.timeStamp + ".";
                Winston.info(_this.message + ".");
                _this.updateFloodLayer(s.timeStamp, data);
                _this.fsm.trigger(SimSvc.SimCommand.Finish);
            });
            return;
        }
        this.fsm.trigger(SimSvc.SimCommand.Finish);
    };
    /**
     * Check whether the requested scenario exists, and start it.
     */
    FloodSim.prototype.startScenario = function (scenario) {
        this.floodingHasStarted = this.floodSims.hasOwnProperty(scenario);
        if (!this.floodingHasStarted)
            return;
        this.pubFloodingScenario.scenario = scenario;
        this.pubFloodingScenario.startTime = this.simTime;
        var s = this.floodSims[scenario][0];
        var d = this.pubFloodingScenario.startTime.addMinutes(s.timeStamp);
        this.nextEvent = d.getTime();
        this.message = scenario + " loaded. Next event at " + d.toLocaleString();
        Winston.info(this.message + ".");
    };
    /**
     * Update the published flood layer with new data.
     */
    FloodSim.prototype.updateFloodLayer = function (timeStamp, data) {
        var layer = _.clone(this.pubFloodingScenario.layer);
        layer.data = data;
        layer.url = '';
        this.pubFloodingScenario.timeStamp = timeStamp;
        this.addUpdateLayer(layer, {}, function () { });
    };
    FloodSim.prototype.extractTimeStamp = function (filename) {
        var timeStamp;
        try {
            timeStamp = +filename.replace('.asc', '');
        }
        catch (e) {
            Winston.error("Error reading timestamp from " + filename + ". The filename should be a number (the number of minutes since the start of the simulation)!");
            return;
        }
        return timeStamp;
    };
    return FloodSim;
})(SimSvc.SimServiceManager);
exports.FloodSim = FloodSim;
//# sourceMappingURL=FloodSim.js.map