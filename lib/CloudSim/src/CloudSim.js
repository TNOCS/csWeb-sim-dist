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
 * Gas cloud Simulator.
 *
 * Does not calculate a gas cloud, but listens for gas cloud start events (at a certain time and location),
 * and from then on publishes the gas concentration.
 *
 * CloudSim is fed with a number of scenarios, i.e. known gas cloud simulations consisting of a sequence of
 * raster files which contain the gas concentration water depth for a certain event location at a certain time
 * (defined from the start of the gas cloud).
 *
 * Each scenario has its own folder in the 'data/clouds' folder. The folder contains files, where the filename of
 * each file is the time in seconds since the cloud started.
 *
 * Based on the received trigger, it will publish a selected scenario.
 *
 * TOOD
 * Add a REST interface to inform others what kinds of keys / messages you expect, and what you need.
 */
var CloudSim = (function (_super) {
    __extends(CloudSim, _super);
    function CloudSim(namespace, name, isClient, options) {
        if (isClient === void 0) { isClient = false; }
        if (options === void 0) { options = {}; }
        _super.call(this, namespace, name, isClient, options);
        this.isClient = isClient;
        this.options = options;
        /** Relative folder for the scenarios */
        this.relativeScenarioFolder = 'scenarios';
        /** Base folder for the scenarios */
        this.scenarioFolder = 'scenarios';
        /** If true, the clouding has started */
        this.cloudHasStarted = false;
        /** A list of available cloud simulations, i.e. cloudSims[scenarioName] = { timeStamp, layer } */
        this.cloudSims = {};
    }
    CloudSim.prototype.start = function () {
        _super.prototype.start.call(this);
        this.reset();
        this.initFSM();
        this.loadAllScenarioFiles();
    };
    CloudSim.prototype.reset = function () {
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/layers'));
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/keys'));
        this.publishCloudLayer();
        this.fsm.currentState = SimSvc.SimState.Ready;
        this.sendAck(this.fsm.currentState);
    };
    /**
     * Initialize the FSM.
     */
    CloudSim.prototype.initFSM = function () {
        var _this = this;
        this.fsm.onEnter(SimSvc.SimState.Idle, function (from) {
            _this.message = 'Scenario has been reset.';
            _this.reset();
            return true;
        });
        this.subscribeKey('sim.cloudSimCmd', {}, function (topic, message, params) {
            Winston.info("Topic: " + topic + ", Msg: " + JSON.stringify(message, null, 2) + ", Params: " + (params ? JSON.stringify(params, null, 2) : '-') + ".");
            if (message.hasOwnProperty('scenario'))
                _this.startScenario(message['scenario']);
            if (message.hasOwnProperty('next'))
                _this.publishNextCloudLayer(Number.MAX_VALUE);
        });
        // When the simulation time is changed:
        // 1. Check if we have to publish a new Layer
        // 2. If there is a new layer, read the asc grid file and put it in the layer.data property
        this.on('simTimeChanged', function () {
            var scenario = _this.pubCloudScenario.scenario;
            if (!scenario)
                return;
            if (_this.cloudSims[scenario][_this.cloudSims[scenario].length - 1].timeStamp === _this.pubCloudScenario.timeStamp) {
                _this.message = scenario + " scenario has ended.";
                _this.nextEvent = null;
                _this.sendAck(_this.fsm.currentState);
                return;
            }
            var secondsSinceStart = _this.simTime.diffSeconds(_this.pubCloudScenario.startTime);
            _this.publishNextCloudLayer(secondsSinceStart);
        });
    };
    /**
     * Create and publish the cloud layer.
     */
    CloudSim.prototype.publishCloudLayer = function () {
        var layer = this.createNewCloudLayer("", 'Initial cloud status.');
        this.pubCloudScenario = {
            scenario: '',
            timeStamp: -1,
            startTime: null,
            layer: layer
        };
        this.addUpdateLayer(layer, {}, function () { });
    };
    CloudSim.prototype.createNewCloudLayer = function (file, description) {
        var layer = {
            server: this.options.server,
            id: 'CloudSim',
            title: 'Cloud',
            description: description,
            features: [],
            storage: 'file',
            enabled: true,
            isDynamic: true,
            data: '',
            url: file,
            typeUrl: this.options.server + "/api/resources/cloudsimtypes",
            type: 'grid',
            renderType: 'gridlayer',
            dataSourceParameters: {
                propertyName: 'c',
                gridType: 'esri',
                projection: 'WGS84',
                legendStringFormat: '{0:0.0000}mg/m3'
            },
            defaultFeatureType: 'cloud',
            defaultLegendProperty: 'c'
        };
        return layer;
    };
    /**
     * Load all the scenarios and all cloud simulations.
     */
    CloudSim.prototype.loadAllScenarioFiles = function () {
        var _this = this;
        var selectedHeight = 200;
        // Read scenarios from the folder
        this.scenarioFolder = path.join(this.rootPath, this.relativeScenarioFolder);
        if (!fs.existsSync(this.scenarioFolder))
            return;
        // Start loading all data
        var scenarios = csweb.getDirectories(this.scenarioFolder);
        scenarios.forEach(function (scenario) {
            var scenarioFolder = path.join(_this.scenarioFolder, scenario);
            var heightLevels = csweb.getDirectories(scenarioFolder);
            heightLevels.forEach(function (hl) {
                if (+hl !== selectedHeight)
                    return;
                var heightFolder = path.join(_this.scenarioFolder, scenario, hl);
                var files = fs.readdirSync(heightFolder);
                files.forEach(function (f) {
                    var ext = path.extname(f);
                    var file = path.join(heightFolder, f);
                    if (ext !== '.asc')
                        return;
                    _this.addToScenarios(scenario, file);
                });
            });
        });
    };
    CloudSim.prototype.addToScenarios = function (scenario, file) {
        var timeStamp = this.extractTimeStamp(path.basename(file));
        var layer = this.createNewCloudLayer(file, "Cloud " + scenario + ": situation after " + timeStamp + " seconds.");
        if (!this.cloudSims.hasOwnProperty(scenario))
            this.cloudSims[scenario] = [];
        this.cloudSims[scenario].push({
            timeStamp: timeStamp,
            layer: layer
        });
        // Sort files on every insertion, so we process them in the right sequence too.
        this.cloudSims[scenario].sort(function (a, b) {
            return (a.timeStamp < b.timeStamp) ? -1 : 1;
        });
    };
    /** Publish the next available clouding layer. */
    CloudSim.prototype.publishNextCloudLayer = function (secondsSinceStart) {
        var _this = this;
        var scenario = this.pubCloudScenario.scenario;
        var publishedTimeStamp = this.pubCloudScenario.timeStamp;
        this.fsm.trigger(SimSvc.SimCommand.Run);
        Winston.info("Start time: " + this.pubCloudScenario.startTime.toLocaleTimeString() + ".");
        Winston.info("Current time: " + this.simTime.toLocaleTimeString() + ".");
        Winston.info("Seconds since start: " + secondsSinceStart + ".");
        for (var i in this.cloudSims[scenario]) {
            var s = this.cloudSims[scenario][i];
            if (s.timeStamp <= publishedTimeStamp)
                continue;
            if (s.timeStamp > secondsSinceStart) {
                this.fsm.trigger(SimSvc.SimCommand.Finish);
                return;
            }
            this.pubCloudScenario.timeStamp = s.timeStamp;
            var keys = Object.keys(this.cloudSims[scenario]);
            var index = keys.indexOf(i);
            var nextCloud = this.cloudSims[scenario][keys[index + 1]];
            Winston.warn("nextCloud: " + nextCloud.timeStamp);
            this.nextEvent = (nextCloud) ? (this.pubCloudScenario.startTime.addSeconds(nextCloud.timeStamp)).getTime() : null;
            fs.readFile(s.layer.url, 'utf8', function (err, data) {
                if (err) {
                    Winston.error("Error reading file: " + err + ".");
                    _this.fsm.trigger(SimSvc.SimCommand.Finish);
                    return;
                }
                _this.message = scenario + ": seconds " + s.timeStamp + ".";
                Winston.info(_this.message + ".");
                _this.updateCloudLayer(s.timeStamp, data);
                _this.fsm.trigger(SimSvc.SimCommand.Finish);
            });
            return;
        }
        this.fsm.trigger(SimSvc.SimCommand.Finish);
    };
    /**
     * Check whether the requested scenario exists, and start it.
     */
    CloudSim.prototype.startScenario = function (scenario) {
        this.cloudHasStarted = this.cloudSims.hasOwnProperty(scenario);
        if (!this.cloudHasStarted)
            return;
        this.pubCloudScenario.scenario = scenario;
        this.pubCloudScenario.startTime = this.simTime;
        var s = this.cloudSims[scenario][0];
        var d = this.pubCloudScenario.startTime.addSeconds(s.timeStamp);
        this.nextEvent = d.getTime();
        this.message = scenario + " loaded. Next event at " + d.toLocaleString();
        Winston.info(this.message + ".");
    };
    /**
     * Update the published cloud layer with new data.
     */
    CloudSim.prototype.updateCloudLayer = function (timeStamp, data) {
        var layer = _.clone(this.pubCloudScenario.layer);
        layer.data = data;
        layer.url = '';
        this.pubCloudScenario.timeStamp = timeStamp;
        this.addUpdateLayer(layer, {}, function () { });
    };
    CloudSim.prototype.extractTimeStamp = function (filename) {
        var timeStamp;
        try {
            timeStamp = +filename.replace('.asc', '');
        }
        catch (e) {
            Winston.error("Error reading timestamp from " + filename + ". The filename should be a number (the number of seconds since the start of the simulation)!");
            return;
        }
        return timeStamp;
    };
    return CloudSim;
})(SimSvc.SimServiceManager);
exports.CloudSim = CloudSim;
//# sourceMappingURL=CloudSim.js.map