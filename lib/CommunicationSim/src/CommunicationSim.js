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
 * CommunicationSim
 *
 * It listens to floodings: when a flooding occurs, all communication towers are checked, and, if flooded,
 * fail to perform their function.
 * Also, in case they experience a blackout, they will fail too.
 */
var CommunicationSim = (function (_super) {
    __extends(CommunicationSim, _super);
    function CommunicationSim(namespace, name, isClient, options) {
        var _this = this;
        if (isClient === void 0) { isClient = false; }
        if (options === void 0) { options = {}; }
        _super.call(this, namespace, name, isClient, options);
        this.isClient = isClient;
        this.options = options;
        /** Source folder for the original source files */
        this.sourceFolder = '';
        this.communicationObjects = [];
        this.on(csweb.Event[csweb.Event.LayerChanged], function (changed) {
            if (changed.id !== 'floodsim' || !changed.value)
                return;
            var layer = changed.value;
            if (!layer.data)
                return;
            Winston.info("CommSim: Floodsim layer received. ID: " + changed.id + " Type:" + changed.type);
            _this.flooding(layer);
        });
        this.on(csweb.Event[csweb.Event.FeatureChanged], function (changed) {
            if (changed.id !== 'powerstations' || !changed.value)
                return;
            var f = changed.value;
            Winston.info("CommSim: Powerstations feature received. ID: " + changed.id + " Type:" + changed.type);
            _this.blackout(f);
        });
        this.on(csweb.Event[csweb.Event.FeatureChanged], function (changed) {
            if (!changed.id || !(changed.id === 'communicationobjects') || !changed.value)
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
                _this.communicationObjects.some(function (co, index) {
                    if (co.id === f.id) {
                        foundIndex = index;
                    }
                    return (foundIndex > -1);
                });
                if (foundIndex > -1)
                    _this.communicationObjects[foundIndex] = f;
            }
            else {
                // Update all features of the same featuretype
                var dependencies = {};
                Object.keys(f.properties).forEach(function (key) {
                    if (key === 'state' || key.indexOf('_dep') === 0) {
                        dependencies[key] = f.properties[key];
                    }
                });
                _this.communicationObjects.forEach(function (co, index) {
                    if (co.properties['featureTypeId'] === f.properties['featureTypeId']) {
                        Object.keys(dependencies).forEach(function (dep) {
                            co.properties[dep] = dependencies[dep];
                        });
                        if (co.id !== f.id) {
                            // Don't send update for the selectedFeature or it will loop forever...
                            _this.updateFeature(_this.communicationObjectsLayer.id, co, {}, function () { });
                        }
                    }
                });
            }
            Winston.info('CommSim: Feature update received');
        });
    }
    CommunicationSim.prototype.start = function (sourceFolder) {
        _super.prototype.start.call(this);
        this.sourceFolder = sourceFolder;
        this.reset();
        this.initFSM();
    };
    /**
     * Initialize the FSM, basically setting the simulation start time.
     */
    CommunicationSim.prototype.initFSM = function () {
        var _this = this;
        // Specify the behaviour of the sim.
        this.fsm.onEnter(SimSvc.SimState.Ready, function (from) {
            //Why is this never reached?
            if (from === SimSvc.SimState.Idle) {
                null;
            }
            return true;
        });
        this.fsm.onEnter(SimSvc.SimState.Idle, function (from) {
            _this.reset();
            _this.message = 'Communication objects have been reset.';
            return true;
        });
    };
    CommunicationSim.prototype.blackout = function (f) {
        var failedObjects = this.checkBlackoutAreas(f);
    };
    CommunicationSim.prototype.checkBlackoutAreas = function (f) {
        // var totalBlackoutArea = this.concatenateBlackoutAreas(f);
        var totalBlackoutArea = f.geometry;
        var failedObjects = [];
        // Check if CO is in blackout area
        for (var i = 0; i < this.communicationObjects.length; i++) {
            var co = this.communicationObjects[i];
            var state = this.getFeatureState(co);
            if (state === SimSvc.InfrastructureState.Failed) {
                failedObjects.push(co.properties['Name']);
                continue;
            }
            // var inBlackout = this.pointInsideMultiPolygon(co.geometry.coordinates, totalBlackoutArea.coordinates);
            var inBlackout = this.pointInsidePolygon(co.geometry.coordinates, totalBlackoutArea.coordinates);
            if (inBlackout) {
                this.setFeatureState(co, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.NoBackupPower, true);
                failedObjects.push(co.properties['Name']);
            }
        }
        return failedObjects;
    };
    CommunicationSim.prototype.concatenateBlackoutAreas = function (layer) {
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
    CommunicationSim.prototype.flooding = function (layer) {
        var failedObjects = this.checkWaterLevel(layer);
    };
    CommunicationSim.prototype.checkWaterLevel = function (layer) {
        var getWaterLevel = this.convertLayerToGrid(layer);
        var failedObjects = [];
        // Check is CO is flooded
        for (var i = 0; i < this.communicationObjects.length; i++) {
            var co = this.communicationObjects[i];
            var state = this.getFeatureState(co);
            if (state === SimSvc.InfrastructureState.Failed) {
                failedObjects.push(co.properties['Name']);
                continue;
            }
            var waterLevel = getWaterLevel(co.geometry.coordinates);
            // Check the max water level the object is able to resist
            var waterResistanceLevel = 0;
            if (co.properties.hasOwnProperty('dependencies')) {
                co.properties['dependencies'].forEach(function (dep) {
                    var splittedDep = dep.split('#');
                    if (splittedDep.length === 2) {
                        if (splittedDep[0] !== 'water')
                            return;
                        waterResistanceLevel = +splittedDep[1];
                    }
                });
            }
            if (waterLevel > waterResistanceLevel) {
                this.setFeatureState(co, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.Flooded, true);
                failedObjects.push(co.properties['Name']);
            }
            else if (waterLevel > 0) {
                this.setFeatureState(co, SimSvc.InfrastructureState.Stressed, SimSvc.FailureMode.Flooded, true);
            }
        }
        return failedObjects;
    };
    CommunicationSim.prototype.convertLayerToGrid = function (layer) {
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
    CommunicationSim.prototype.reset = function () {
        var _this = this;
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/layers'));
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/keys'));
        this.communicationObjects = [];
        // Copy original csweb layers to dynamic layers
        var objectsFile = path.join(this.sourceFolder, 'comm_objects.json');
        fs.readFile(objectsFile, function (err, data) {
            if (err) {
                Winston.error("Error reading " + objectsFile + ": " + err);
                return;
            }
            var co = JSON.parse(data.toString());
            _this.communicationObjectsLayer = _this.createNewLayer('communicationobjects', 'Telecommunicatie', co.features);
            _this.communicationObjectsLayer.features.forEach(function (f) {
                if (!f.id)
                    f.id = csweb.newGuid();
                if (f.geometry.type !== 'Point')
                    return;
                _this.setFeatureState(f, SimSvc.InfrastructureState.Ok);
                _this.communicationObjects.push(f);
            });
            _this.publishLayer(_this.communicationObjectsLayer);
        });
        this.fsm.currentState = SimSvc.SimState.Ready;
        this.sendAck(this.fsm.currentState);
    };
    /** Set the state and failure mode of a feature, optionally publishing it too. */
    CommunicationSim.prototype.setFeatureState = function (feature, state, failureMode, publish) {
        if (failureMode === void 0) { failureMode = SimSvc.FailureMode.None; }
        if (publish === void 0) { publish = false; }
        feature.properties['state'] = state;
        feature.properties['failureMode'] = failureMode;
        if (!publish)
            return;
        // Publish feature update
        this.updateFeature(this.communicationObjectsLayer.id, feature, {}, function () { });
        // Publish PowerSupplyArea layer
        // if (state === SimSvc.InfrastructureState.Failed && feature.properties.hasOwnProperty('contour')) {
        //     var contour = new csweb.Feature();
        //     contour.id = csweb.newGuid();
        //     contour.properties = {
        //         Name: 'Contour area',
        //         featureTypeId: 'AffectedArea'
        //     };
        //     contour.geometry = JSON.parse(feature.properties['contour']);
        //     this.addFeature(this.communicationObjectsLayer.id, contour, <csweb.ApiMeta>{}, () => { });
        // }
    };
    CommunicationSim.prototype.getFeatureState = function (feature) {
        return feature.properties['state'];
    };
    CommunicationSim.prototype.createNewLayer = function (id, title, features, description) {
        var layer = {
            server: this.options.server,
            id: id,
            title: title,
            description: description,
            features: features,
            storage: 'file',
            enabled: true,
            isDynamic: true,
            typeUrl: this.options.server + "/api/resources/comm_objects",
            type: 'dynamicgeojson',
        };
        return layer;
    };
    /**
     * Create and publish the layer.
     */
    CommunicationSim.prototype.publishLayer = function (layer) {
        this.addUpdateLayer(layer, {}, function () { });
    };
    /**
     * pointInsidePolygon returns true if a 2D point lies within a polygon of 2D points
     * @param  {number[]}   point   [lat, lng]
     * @param  {number[][]} polygon [[lat, lng], [lat,lng],...]
     * @return {boolean}            Inside == true
     */
    CommunicationSim.prototype.pointInsidePolygon = function (point, polygon) {
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
    CommunicationSim.prototype.pointInsideMultiPolygon = function (point, multipoly) {
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
    return CommunicationSim;
})(SimSvc.SimServiceManager);
exports.CommunicationSim = CommunicationSim;
//# sourceMappingURL=CommunicationSim.js.map