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
/**
 * Electrical Network Simulator.
 *
 * It listens to floodings: when a flooding occurs, all power substations are checked, and, if flooded,
 * fail to perform their function.
 * Also, in case their dependencies are no longer satisfied, e.g. when (all of) their power supplying
 * substation fails, it will fail too.
 */
var ElectricalNetworkSim = (function (_super) {
    __extends(ElectricalNetworkSim, _super);
    function ElectricalNetworkSim(namespace, name, isClient, options) {
        var _this = this;
        if (isClient === void 0) { isClient = false; }
        if (options === void 0) { options = {}; }
        _super.call(this, namespace, name, isClient, options);
        this.isClient = isClient;
        this.options = options;
        /** Source folder for the original source files */
        this.sourceFolder = '';
        this.powerStations = [];
        this.publishedAreas = [];
        this.subscribeKey('sim.PowerStationCmd', {}, function (topic, message, params) {
            Winston.info("Topic: " + topic + ", Msg: " + JSON.stringify(message, null, 2) + ", Params: " + (params ? JSON.stringify(params, null, 2) : '-') + ".");
            if (message.hasOwnProperty('powerStation') && message.hasOwnProperty('state')) {
                var name = message['powerStation'];
                _this.powerStations.some(function (ps) {
                    if (ps.properties.hasOwnProperty('Name') && ps.properties['Name'] !== name)
                        return false;
                    _this.setFeatureState(ps, message['state'], SimSvc.FailureMode.Unknown, true);
                    return true;
                });
            }
        });
        this.on(csweb.Event[csweb.Event.LayerChanged], function (changed) {
            if (changed.id !== 'floodsim' || !changed.value)
                return;
            var layer = changed.value;
            if (!layer.data)
                return;
            Winston.info('ElecSim: Floodsim layer received');
            Winston.info("ID  : " + changed.id);
            Winston.info("Type: " + changed.type);
            _this.flooding(layer);
        });
        this.on(csweb.Event[csweb.Event.FeatureChanged], function (changed) {
            if (!changed.id || !(changed.id === 'powerstations') || !changed.value)
                return;
            var updateAllFeatures = false;
            if (changed.value.hasOwnProperty('changeAllFeaturesOfType') && changed.value['changeAllFeaturesOfType'] === true) {
                updateAllFeatures = true;
                delete changed.value['changeAllFeaturesOfType'];
            }
            var f = changed.value;
            if (!updateAllFeatures) {
                // Update a single feature
                var foundIndex = -1;
                _this.powerStations.some(function (ps, index) {
                    if (ps.id === f.id) {
                        foundIndex = index;
                    }
                    return (foundIndex > -1);
                });
                if (foundIndex > -1) {
                    _this.powerStations[foundIndex] = f;
                    if (_this.getFeatureState(f) === SimSvc.InfrastructureState.Failed) {
                        var failedPowerStation = [f.properties['Name']];
                        _this.checkDependencies(failedPowerStation);
                    }
                    _this.publishPowerSupplyArea(f);
                }
            }
            else {
                // Update all features of the same featuretype
                var dependencies = {};
                Object.keys(f.properties).forEach(function (key) {
                    if (key === 'state' || key.indexOf('_dep') === 0) {
                        dependencies[key] = f.properties[key];
                    }
                });
                _this.powerStations.forEach(function (ps, index) {
                    if (ps.properties['featureTypeId'] === f.properties['featureTypeId']) {
                        Object.keys(dependencies).forEach(function (dep) {
                            ps.properties[dep] = dependencies[dep];
                        });
                        if (ps.id !== f.id) {
                            // Don't send update for the selectedFeature or it will loop forever...
                            _this.updateFeature(_this.powerLayer.id, ps, {}, function () { });
                        }
                    }
                });
            }
            Winston.info('ElecSim: Feature update received');
        });
    }
    ElectricalNetworkSim.prototype.start = function (sourceFolder) {
        _super.prototype.start.call(this);
        this.sourceFolder = sourceFolder;
        this.reset();
        this.initFSM();
    };
    /**
     * Initialize the FSM, basically setting the simulation start time.
     */
    ElectricalNetworkSim.prototype.initFSM = function () {
        var _this = this;
        this.fsm.onEnter(SimSvc.SimState.Idle, function (from) {
            _this.reset();
            _this.message = 'Network has been reset.';
            return true;
        });
    };
    ElectricalNetworkSim.prototype.flooding = function (layer) {
        var failedPowerStations = this.checkWaterLevel(layer);
        this.checkDependencies(failedPowerStations);
    };
    ElectricalNetworkSim.prototype.checkWaterLevel = function (layer) {
        var getWaterLevel = this.convertLayerToGrid(layer);
        var failedPowerStations = [];
        // Check is Powerstation is flooded
        for (var i = 0; i < this.powerStations.length; i++) {
            var ps = this.powerStations[i];
            var state = this.getFeatureState(ps);
            if (state === SimSvc.InfrastructureState.Failed) {
                failedPowerStations.push(ps.properties['Name']);
                continue;
            }
            var waterLevel = getWaterLevel(ps.geometry.coordinates);
            // Check the max water level the station is able to resist
            var waterResistanceLevel = 0;
            if (ps.properties.hasOwnProperty('_dep_water')) {
                waterResistanceLevel = +ps.properties['_dep_water'];
            }
            if (waterLevel > waterResistanceLevel) {
                this.setFeatureState(ps, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.Flooded, true);
                failedPowerStations.push(ps.properties['Name']);
            }
            else if (waterLevel > 0) {
                this.setFeatureState(ps, SimSvc.InfrastructureState.Stressed, SimSvc.FailureMode.Flooded, true);
            }
        }
        return failedPowerStations;
    };
    ElectricalNetworkSim.prototype.checkDependencies = function (failedPowerStations) {
        if (failedPowerStations.length === 0)
            return;
        var additionalFailures = false;
        for (var i = 0; i < this.powerStations.length; i++) {
            var ps = this.powerStations[i];
            if (!ps.properties.hasOwnProperty('_dep_features'))
                continue;
            var state = this.getFeatureState(ps);
            if (state === SimSvc.InfrastructureState.Failed)
                continue;
            var dependencies = ps.properties['_dep_features'];
            var failedDependencies = 0;
            var okDependencies = 0;
            dependencies.forEach(function (dpName) {
                if (failedPowerStations.indexOf(dpName) >= 0) {
                    failedDependencies++;
                }
                else {
                    okDependencies++;
                }
            });
            if (failedDependencies === 0)
                continue;
            if (failedDependencies < (okDependencies + failedDependencies)) {
                this.setFeatureState(ps, SimSvc.InfrastructureState.Stressed, SimSvc.FailureMode.LimitedPower, true);
            }
            else {
                this.setFeatureState(ps, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.NoMainPower, true);
                failedPowerStations.push(ps.properties["Name"]);
                additionalFailures = true;
            }
        }
        if (additionalFailures)
            this.checkDependencies(failedPowerStations);
    };
    ElectricalNetworkSim.prototype.convertLayerToGrid = function (layer) {
        var gridParams = {};
        csweb.IsoLines.convertEsriHeaderToGridParams(layer, gridParams);
        var gridData = csweb.IsoLines.convertDataToGrid(layer, gridParams);
        return function getWaterLevel(pt) {
            var col = Math.floor((pt[0] - gridParams.startLon) / gridParams.deltaLon);
            if (col < 0 || col >= gridData[0].length)
                return -1;
            var row = Math.floor((pt[1] - gridParams.startLat) / gridParams.deltaLat);
            if (row < 0 || row >= gridData.length)
                return -1;
            var waterLevel = gridData[row][col];
            return waterLevel;
        };
    };
    /** Reset the state to the original state. */
    ElectricalNetworkSim.prototype.reset = function () {
        var _this = this;
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/layers'));
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/keys'));
        this.powerStations = [];
        this.publishedAreas = [];
        // Copy original csweb layers to dynamic layers
        var stationsFile = path.join(this.sourceFolder, 'power_stations.json');
        fs.readFile(stationsFile, function (err, data) {
            if (err) {
                Winston.error("Error reading " + stationsFile + ": " + err);
                return;
            }
            var ps = JSON.parse(data.toString());
            _this.powerLayer = _this.createNewLayer('powerstations', 'Stroomstations', ps.features, 'Elektrische stroomstations');
            _this.powerLayer.features.forEach(function (f) {
                if (!f.id)
                    f.id = csweb.newGuid();
                if (f.geometry.type !== 'Point')
                    return;
                _this.setFeatureState(f, SimSvc.InfrastructureState.Ok);
                _this.powerStations.push(f);
            });
            _this.publishLayer(_this.powerLayer);
        });
        this.fsm.currentState = SimSvc.SimState.Ready;
        this.sendAck(this.fsm.currentState);
    };
    /** Set the state and failure mode of a feature, optionally publishing it too. */
    ElectricalNetworkSim.prototype.setFeatureState = function (feature, state, failureMode, publish) {
        if (failureMode === void 0) { failureMode = SimSvc.FailureMode.None; }
        if (publish === void 0) { publish = false; }
        feature.properties['state'] = state;
        feature.properties['failureMode'] = failureMode;
        if (!publish)
            return;
        // Publish feature update
        this.updateFeature(this.powerLayer.id, feature, {}, function () { });
        this.publishPowerSupplyArea(feature);
    };
    // Publish PowerSupplyArea layer
    ElectricalNetworkSim.prototype.publishPowerSupplyArea = function (feature) {
        var state = this.getFeatureState(feature);
        if (state === SimSvc.InfrastructureState.Failed && feature.properties.hasOwnProperty('powerSupplyArea')
            && this.publishedAreas.indexOf(feature.id) < 0) {
            var psa = new csweb.Feature();
            psa.id = csweb.newGuid();
            psa.properties = {
                Name: 'Blackout area',
                featureTypeId: 'AffectedArea'
            };
            psa.geometry = JSON.parse(feature.properties['powerSupplyArea']);
            this.publishedAreas.push(feature.id);
            this.updateFeature(this.powerLayer.id, psa, {}, function () { });
        }
    };
    ElectricalNetworkSim.prototype.getFeatureState = function (feature) {
        return parseInt(feature.properties['state'], 10);
    };
    ElectricalNetworkSim.prototype.createNewLayer = function (id, title, features, description) {
        var layer = {
            server: this.options.server,
            id: id,
            title: title,
            description: description,
            features: features,
            storage: 'file',
            enabled: true,
            isDynamic: true,
            typeUrl: this.options.server + "/api/resources/electrical_network",
            type: 'dynamicgeojson',
        };
        return layer;
    };
    /**
     * Create and publish the layer.
     */
    ElectricalNetworkSim.prototype.publishLayer = function (layer) {
        this.addUpdateLayer(layer, {}, function () { });
    };
    return ElectricalNetworkSim;
})(SimSvc.SimServiceManager);
exports.ElectricalNetworkSim = ElectricalNetworkSim;
//# sourceMappingURL=ElectricalNetworkSim.js.map