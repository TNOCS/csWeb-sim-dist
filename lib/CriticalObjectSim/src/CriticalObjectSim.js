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
 * CriticalObjectSim
 *
 * It listens to floodings: when a flooding occurs, all critical objects are checked, and, if flooded,
 * fail to perform their function.
 * Also, in case they experience a blackout, they will fail too.
 */
var CriticalObjectSim = (function (_super) {
    __extends(CriticalObjectSim, _super);
    function CriticalObjectSim(namespace, name, isClient, options) {
        var _this = this;
        if (isClient === void 0) { isClient = false; }
        if (options === void 0) { options = {}; }
        _super.call(this, namespace, name, isClient, options);
        this.isClient = isClient;
        this.options = options;
        /** Relative folder for the original source files */
        this.sourceFolder = '';
        this.criticalObjects = [];
        this.on(csweb.Event[csweb.Event.LayerChanged], function (changed) {
            if (changed.id !== 'floodsim' || !changed.value)
                return;
            var layer = changed.value;
            if (!layer.data)
                return;
            Winston.info('COSim: Floodsim layer received');
            Winston.info("ID  : " + changed.id);
            Winston.info("Type: " + changed.type);
            _this.flooding(layer);
        });
        this.on(csweb.Event[csweb.Event.FeatureChanged], function (changed) {
            if (changed.id !== 'powerstations' || !changed.value)
                return;
            var f = changed.value;
            Winston.info('COSim: Powerstations feature received');
            Winston.info("ID  : " + changed.id);
            Winston.info("Type: " + changed.type);
            _this.blackout(f);
        });
        this.on(csweb.Event[csweb.Event.FeatureChanged], function (changed) {
            if (!changed.id || !(changed.id === 'criticalobjects') || !changed.value)
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
                _this.criticalObjects.some(function (co, index) {
                    if (co.id === f.id) {
                        foundIndex = index;
                    }
                    return (foundIndex > -1);
                });
                if (foundIndex > -1)
                    _this.criticalObjects[foundIndex] = f;
            }
            else {
                // Update all features of the same featuretype
                var dependencies = {};
                Object.keys(f.properties).forEach(function (key) {
                    if (key === 'state' || key.indexOf('_dep') === 0) {
                        dependencies[key] = f.properties[key];
                    }
                });
                _this.criticalObjects.forEach(function (co, index) {
                    if (co.properties['featureTypeId'] === f.properties['featureTypeId']) {
                        Object.keys(dependencies).forEach(function (dep) {
                            co.properties[dep] = dependencies[dep];
                        });
                        if (co.id !== f.id) {
                            // Don't send update for the selectedFeature or it will loop forever...
                            _this.updateFeature(_this.criticalObjectsLayer.id, co, {}, function () { });
                        }
                    }
                });
            }
            Winston.info('CoSim: Feature update received');
        });
        this.on('simTimeChanged', function () {
            if (!_this.nextEvent || _this.nextEvent > _this.simTime.getTime())
                return;
            _this.checkUps(); // Check power supplies
        });
    }
    CriticalObjectSim.prototype.start = function (sourceFolder) {
        _super.prototype.start.call(this);
        this.sourceFolder = sourceFolder;
        this.reset();
        this.initFSM();
    };
    /**
     * Initialize the FSM, basically setting the simulation start time.
     */
    CriticalObjectSim.prototype.initFSM = function () {
        var _this = this;
        // Specify the behaviour of the sim.
        this.fsm.onEnter(SimSvc.SimState.Ready, function (from) {
            //Why is this never reached?
            if (from === SimSvc.SimState.Idle) {
                _this.bedsChartData = [
                    {
                        name: "available",
                        values: []
                    }, {
                        name: "failed",
                        values: []
                    }, {
                        name: "stressed",
                        values: []
                    }];
                _this.sendChartValues();
            }
            return true;
        });
        this.fsm.onEnter(SimSvc.SimState.Idle, function (from) {
            _this.reset();
            _this.message = 'Critical objects have been reset.';
            return true;
        });
    };
    CriticalObjectSim.prototype.checkUps = function () {
        var updateChart = false;
        var eventTimes = [];
        for (var i = 0; i < this.criticalObjects.length; i++) {
            var co = this.criticalObjects[i];
            if (!co.properties.hasOwnProperty('willFailAt'))
                continue;
            if (co.properties['willFailAt'] > this.simTime.getTime()) {
                eventTimes.push(co.properties['willFailAt']);
                continue;
            }
            else {
                delete co.properties['willFailAt'];
                this.setFeatureState(co, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.NoBackupPower, null, true);
                updateChart = true;
            }
        }
        if (eventTimes.length > 0) {
            this.nextEvent = _.min(eventTimes);
        }
        else {
            this.nextEvent = null;
        }
        if (updateChart)
            this.sendChartValues();
    };
    CriticalObjectSim.prototype.blackout = function (f) {
        var failedObjects = this.checkBlackoutAreas(f);
        this.checkDependencies(failedObjects);
        this.sendChartValues(); // e.g., nr. of evacuated hospital beds.
    };
    CriticalObjectSim.prototype.sendChartValues = function () {
        var _this = this;
        if (!this.bedsChartData)
            return;
        var stressedBeds = 0;
        var failedBeds = 0;
        var availableBeds = 0;
        for (var i = 0; i < this.criticalObjects.length; i++) {
            var co = this.criticalObjects[i];
            if (!co.properties.hasOwnProperty('Aantal bedden'))
                continue;
            var beds = co.properties['Aantal bedden'];
            var state = this.getFeatureState(co);
            switch (state) {
                case SimSvc.InfrastructureState.Ok:
                    availableBeds += beds;
                    break;
                case SimSvc.InfrastructureState.Stressed:
                    stressedBeds += beds;
                    break;
                case SimSvc.InfrastructureState.Failed:
                    failedBeds += beds;
                    break;
            }
        }
        if (!this.simStartTime) {
            Winston.error('CriticalObjectsSim: SimStartTime not found!');
            this.simStartTime = new Date(this.simTime.getTime());
        }
        var hours = Math.round((this.simTime.getTime() - this.simStartTime.getTime()) / 3600000);
        this.bedsChartData.forEach(function (c) {
            var last = c.values[c.values.length - 1];
            if (last && last.x === _this.simTime.getTime()) {
                c.values.pop(); //Remove the last element if it has the simtime has not changed yet
            }
            if (c.name === 'failed') {
                c.values.push({ x: hours, y: failedBeds });
            }
            else if (c.name === 'stressed') {
                c.values.push({ x: hours, y: stressedBeds });
            }
            else if (c.name === 'available') {
                c.values.push({ x: hours, y: availableBeds });
                Winston.info("Available beds: " + availableBeds);
            }
        });
        this.updateKey("chart", { values: this.bedsChartData }, {}, function () { });
    };
    CriticalObjectSim.prototype.checkBlackoutAreas = function (f) {
        // var totalBlackoutArea = this.concatenateBlackoutAreas(f);
        var totalBlackoutArea = f.geometry;
        var failedObjects = [];
        // Check if CO is in blackout area
        for (var i = 0; i < this.criticalObjects.length; i++) {
            var co = this.criticalObjects[i];
            var state = this.getFeatureState(co);
            if (state === SimSvc.InfrastructureState.Failed) {
                failedObjects.push(co.properties['name']);
                continue;
            }
            // var inBlackout = this.pointInsideMultiPolygon(co.geometry.coordinates, totalBlackoutArea.coordinates);
            var inBlackout = this.pointInsidePolygon(co.geometry.coordinates, totalBlackoutArea.coordinates);
            if (!inBlackout)
                continue;
            // Check for UPS
            var upsFound = false;
            if (co.properties['state'] === SimSvc.InfrastructureState.Ok && co.properties.hasOwnProperty('_dep_UPS')) {
                var minutes = +co.properties['_dep_UPS'];
                var failTime = this.simTime.addMinutes(minutes);
                upsFound = true;
                this.setFeatureState(co, SimSvc.InfrastructureState.Stressed, SimSvc.FailureMode.NoMainPower, failTime, true);
            }
            if (!upsFound && !co.properties.hasOwnProperty('willFailAt')) {
                this.setFeatureState(co, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.NoBackupPower, null, true);
                failedObjects.push(co.properties['name']);
            }
            if (upsFound) {
                this.checkUps();
            }
        }
        return failedObjects;
    };
    CriticalObjectSim.prototype.concatenateBlackoutAreas = function (layer) {
        var totalArea = { type: "MultiPolygon", coordinates: [] };
        if (!layer || !layer.features)
            return totalArea;
        var count = 0;
        layer.features.forEach(function (f) {
            if (f.properties && f.properties.hasOwnProperty('featureTypeId') && f.properties['featureTypeId'] === 'AffectedArea') {
                if (f.geometry.type === "Polygon") {
                    totalArea.coordinates.push(f.geometry.coordinates);
                    count += 1;
                }
            }
        });
        Winston.info('Concatenated ' + count + ' blackout areas');
        return totalArea;
    };
    CriticalObjectSim.prototype.flooding = function (layer) {
        var failedObjects = this.checkWaterLevel(layer);
        this.checkDependencies(failedObjects);
        this.sendChartValues(); // e.g., nr. of evacuated hospital beds.
    };
    CriticalObjectSim.prototype.checkWaterLevel = function (layer) {
        var getWaterLevel = this.convertLayerToGrid(layer);
        var failedObjects = [];
        // Check is CO is flooded
        for (var i = 0; i < this.criticalObjects.length; i++) {
            var co = this.criticalObjects[i];
            var state = this.getFeatureState(co);
            if (state === SimSvc.InfrastructureState.Failed) {
                failedObjects.push(co.properties['name']);
                continue;
            }
            var waterLevel = getWaterLevel(co.geometry.coordinates);
            // Check the max water level the object is able to resist
            var waterResistanceLevel = 0;
            if (co.properties.hasOwnProperty('_dep_water')) {
                waterResistanceLevel = co.properties['_dep_water'];
            }
            if (waterLevel > waterResistanceLevel) {
                this.setFeatureState(co, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.Flooded, null, true);
                failedObjects.push(co.properties['name']);
            }
            else if (waterLevel > 0) {
                this.setFeatureState(co, SimSvc.InfrastructureState.Stressed, SimSvc.FailureMode.Flooded, null, true);
            }
        }
        return failedObjects;
    };
    CriticalObjectSim.prototype.checkDependencies = function (failedObjects) {
        if (failedObjects.length === 0)
            return;
        var additionalFailures = false;
        for (var i = 0; i < this.criticalObjects.length; i++) {
            var co = this.criticalObjects[i];
            if (!co.properties.hasOwnProperty('_dep_features'))
                continue;
            var state = this.getFeatureState(co);
            if (state === SimSvc.InfrastructureState.Failed)
                continue;
            var dependencies = co.properties['_dep_features'];
            var failedDependencies = 0;
            dependencies.forEach(function (dp) {
                if (failedObjects.indexOf(dp) >= 0)
                    failedDependencies++;
            });
            if (failedDependencies === 0)
                continue;
            if (failedDependencies < dependencies.length) {
                this.setFeatureState(co, SimSvc.InfrastructureState.Stressed, SimSvc.FailureMode.LimitedPower, null, true);
            }
            else {
                this.setFeatureState(co, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.NoMainPower, null, true);
                failedObjects.push(co.properties["Name"]);
                additionalFailures = true;
            }
        }
        if (additionalFailures)
            this.checkDependencies(failedObjects);
    };
    CriticalObjectSim.prototype.convertLayerToGrid = function (layer) {
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
    CriticalObjectSim.prototype.reset = function () {
        var _this = this;
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/layers'));
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/keys'));
        this.criticalObjects = [];
        this.bedsChartData = [{ name: "available", values: [] }, { name: "failed", values: [] }, { name: "stressed", values: [] }];
        this.nextEvent = null;
        // Copy original csweb layers to dynamic layers
        var objectsFile = path.join(this.sourceFolder, 'critical_objects.json');
        fs.readFile(objectsFile, function (err, data) {
            if (err) {
                Winston.error("Error reading " + objectsFile + ": " + err);
                return;
            }
            var co = JSON.parse(data.toString());
            _this.criticalObjectsLayer = _this.createNewLayer('criticalobjects', 'Kwetsbare objecten', co.features);
            _this.criticalObjectsLayer.features.forEach(function (f) {
                if (!f.id)
                    f.id = csweb.newGuid();
                if (f.geometry.type !== 'Point')
                    return;
                _this.setFeatureState(f, SimSvc.InfrastructureState.Ok);
                _this.criticalObjects.push(f);
            });
            _this.publishLayer(_this.criticalObjectsLayer);
            _this.sendChartValues();
        });
        this.fsm.currentState = SimSvc.SimState.Ready;
        this.sendAck(this.fsm.currentState);
    };
    /** Set the state and failure mode of a feature, optionally publishing it too. */
    CriticalObjectSim.prototype.setFeatureState = function (feature, state, failureMode, failureTime, publish) {
        if (failureMode === void 0) { failureMode = SimSvc.FailureMode.None; }
        if (failureTime === void 0) { failureTime = null; }
        if (publish === void 0) { publish = false; }
        feature.properties['state'] = state;
        feature.properties['failureMode'] = failureMode;
        if (failureTime)
            feature.properties['willFailAt'] = failureTime.getTime();
        if (!publish)
            return;
        // Publish feature update
        this.updateFeature(this.criticalObjectsLayer.id, feature, {}, function () { });
    };
    CriticalObjectSim.prototype.getFeatureState = function (feature) {
        return feature.properties['state'];
    };
    CriticalObjectSim.prototype.createNewLayer = function (id, title, features, description) {
        var layer = {
            server: this.options.server,
            id: id,
            title: title,
            description: description,
            features: features,
            storage: 'file',
            enabled: true,
            isDynamic: true,
            typeUrl: this.options.server + "/api/resources/critical_objects",
            type: 'dynamicgeojson',
        };
        return layer;
    };
    /**
     * Create and publish the layer.
     */
    CriticalObjectSim.prototype.publishLayer = function (layer) {
        this.addUpdateLayer(layer, {}, function () { });
    };
    /**
     * pointInsidePolygon returns true if a 2D point lies within a polygon of 2D points
     * @param  {number[]}   point   [lat, lng]
     * @param  {number[][]} polygon [[lat, lng], [lat,lng],...]
     * @return {boolean}            Inside == true
     */
    CriticalObjectSim.prototype.pointInsidePolygon = function (point, polygon) {
        // https://github.com/substack/point-in-polygon
        // ray-casting algorithm based on
        // http://www.ecse.rpi.edu/Homepages/wrf/Research/Short_Notes/pnpoly.html
        var x = point[0];
        var y = point[1];
        var p = polygon[0];
        var inside = false;
        for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
            var xi = p[i][0], yi = p[i][1];
            var xj = p[j][0], yj = p[j][1];
            var intersect = ((yi > y) != (yj > y))
                && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect)
                inside = !inside;
        }
        return inside;
    };
    /**
     * pointInsideMultiPolygon returns true if a 2D point lies within a multipolygon
     * @param  {number[]}   point   [lat, lng]
     * @param  {number[][][]} polygon [[[lat, lng], [lat,lng]],...]]
     * @return {boolean}            Inside == true
     */
    CriticalObjectSim.prototype.pointInsideMultiPolygon = function (point, multipoly) {
        // https://github.com/substack/point-in-polygon
        // ray-casting algorithm based on
        // http://www.ecse.rpi.edu/Homepages/wrf/Research/Short_Notes/pnpoly.html
        var inside = false;
        for (var i = 0; i < multipoly.length; i++) {
            var polygon = multipoly[i];
            if (this.pointInsidePolygon(point, polygon))
                inside = !inside;
        }
        return inside;
    };
    return CriticalObjectSim;
})(SimSvc.SimServiceManager);
exports.CriticalObjectSim = CriticalObjectSim;
//# sourceMappingURL=CriticalObjectSim.js.map