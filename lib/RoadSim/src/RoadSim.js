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
 * RoadSim
 *
 * It listens to floodings: when a flooding occurs, all roads are checked, and, if flooded,
 * fail to perform their function.
 * Also, in case they experience a blackout, they will fail too.
 */
var RoadSim = (function (_super) {
    __extends(RoadSim, _super);
    function RoadSim(namespace, name, isClient, options) {
        var _this = this;
        if (isClient === void 0) { isClient = false; }
        if (options === void 0) { options = {}; }
        _super.call(this, namespace, name, isClient, options);
        this.isClient = isClient;
        this.options = options;
        /** Source folder for the original source files */
        this.sourceFolder = 'source';
        this.roadObjects = [];
        this.on(csweb.Event[csweb.Event.LayerChanged], function (changed) {
            if (changed.id !== 'floodsim' || !changed.value)
                return;
            var layer = changed.value;
            if (!layer.data)
                return;
            Winston.info('Roadsim: Floodsim layer received');
            Winston.info("ID  : " + changed.id);
            Winston.info("Type: " + changed.type);
            _this.flooding(layer);
        });
        this.on(csweb.Event[csweb.Event.FeatureChanged], function (changed) {
            if (changed.id !== 'powerstations' || !changed.value)
                return;
            var f = changed.value;
            Winston.info('RoadSim: Powerstations feature received');
            Winston.info("ID  : " + changed.id);
            Winston.info("Type: " + changed.type);
            _this.blackout(f);
        });
        this.on(csweb.Event[csweb.Event.FeatureChanged], function (changed) {
            if (!changed.id || !(changed.id === 'roadobjects') || !changed.value)
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
                _this.roadObjects.some(function (ro, index) {
                    if (ro.id === f.id) {
                        foundIndex = index;
                    }
                    return (foundIndex > -1);
                });
                if (foundIndex > -1)
                    _this.roadObjects[foundIndex] = f;
            }
            else {
                // Update all features of the same featuretype
                var dependencies = {};
                Object.keys(f.properties).forEach(function (key) {
                    if (key === 'state' || key.indexOf('_dep') === 0) {
                        dependencies[key] = f.properties[key];
                    }
                });
                _this.roadObjects.forEach(function (ro, index) {
                    if (ro.properties['featureTypeId'] === f.properties['featureTypeId']) {
                        Object.keys(dependencies).forEach(function (dep) {
                            ro.properties[dep] = dependencies[dep];
                        });
                        if (ro.id !== f.id) {
                            // Don't send update for the selectedFeature or it will loop forever...
                            _this.updateFeature(_this.roadObjectsLayer.id, ro, {}, function () { });
                        }
                    }
                });
            }
            Winston.info('RoadSim: Feature update received');
        });
    }
    RoadSim.prototype.start = function (sourceFolder) {
        _super.prototype.start.call(this);
        this.sourceFolder = sourceFolder;
        this.reset();
        this.initFSM();
    };
    /**
     * Initialize the FSM, basically setting the simulation start time.
     */
    RoadSim.prototype.initFSM = function () {
        var _this = this;
        // Specify the behaviour of the sim.
        this.fsm.onEnter(SimSvc.SimState.Ready, function (from) {
            //Why is this never reached?
            if (from === SimSvc.SimState.Idle) {
            }
            return true;
        });
        this.fsm.onEnter(SimSvc.SimState.Idle, function (from) {
            _this.reset();
            _this.message = 'Roads have been reset.';
            return true;
        });
    };
    RoadSim.prototype.blackout = function (f) {
        var failedObjects = this.checkBlackoutAreas(f);
        this.checkDependencies(failedObjects);
    };
    RoadSim.prototype.checkBlackoutAreas = function (f) {
        var totalBlackoutArea = f.geometry;
        var failedObjects = [];
        // Check if ro is in blackout area
        for (var i = 0; i < this.roadObjects.length; i++) {
            var ro = this.roadObjects[i];
            var state = this.getFeatureState(ro);
            if (state === SimSvc.InfrastructureState.Failed) {
                failedObjects.push(ro.properties['name']);
                continue;
            }
            var inBlackout = this.lineInsidePolygon(ro.geometry.coordinates, totalBlackoutArea.coordinates);
            if (inBlackout) {
                this.setFeatureState(ro, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.NoBackupPower, null, true);
                failedObjects.push(ro.properties['name']);
            }
        }
        return failedObjects;
    };
    RoadSim.prototype.concatenateBlackoutAreas = function (layer) {
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
    RoadSim.prototype.flooding = function (layer) {
        var failedObjects = this.checkWaterLevel(layer);
        this.checkDependencies(failedObjects);
    };
    RoadSim.prototype.checkWaterLevel = function (layer) {
        var getWaterLevel = this.convertLayerToGrid(layer);
        var failedObjects = [];
        // Check is CO is flooded
        for (var i = 0; i < this.roadObjects.length; i++) {
            var co = this.roadObjects[i];
            var state = this.getFeatureState(co);
            if (state === SimSvc.InfrastructureState.Failed) {
                failedObjects.push(co.properties['name']);
                continue;
            }
            // Check maximum water level along the raod segment
            var maxWaterLevel = 0;
            if (co.geometry.type.toLowerCase() !== "linestring")
                continue;
            co.geometry.coordinates.forEach(function (segm) {
                var level = getWaterLevel(segm);
                maxWaterLevel = Math.max(maxWaterLevel, level);
            });
            // Check the max water level the road is able to resist
            var waterResistanceLevel = 0;
            if (co.properties.hasOwnProperty('dependencies')) {
                co.properties['dependencies'].forEach(function (dep) {
                    var splittedDep = dep.split('#');
                    if (splittedDep.length === 2) {
                        if (splittedDep[0] === 'water' && co.properties['state'] === SimSvc.InfrastructureState.Ok) {
                            waterResistanceLevel = +splittedDep[1];
                        }
                    }
                });
            }
            // Set the state of the road segment
            if (maxWaterLevel > waterResistanceLevel) {
                this.setFeatureState(co, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.Flooded, null, true);
                failedObjects.push(co.properties['name']);
            }
            else if (maxWaterLevel > 0) {
                this.setFeatureState(co, SimSvc.InfrastructureState.Stressed, SimSvc.FailureMode.Flooded, null, true);
            }
        }
        return failedObjects;
    };
    RoadSim.prototype.checkDependencies = function (failedObjects) {
        if (failedObjects.length === 0)
            return;
        var additionalFailures = false;
        for (var i = 0; i < this.roadObjects.length; i++) {
            var co = this.roadObjects[i];
            if (!co.properties.hasOwnProperty('dependencies'))
                continue;
            var state = this.getFeatureState(co);
            if (state === SimSvc.InfrastructureState.Failed)
                continue;
            var dependencies = co.properties['dependencies'];
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
                failedObjects.push(co.properties["name"]);
                additionalFailures = true;
            }
        }
        if (additionalFailures)
            this.checkDependencies(failedObjects);
    };
    RoadSim.prototype.convertLayerToGrid = function (layer) {
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
    RoadSim.prototype.reset = function () {
        var _this = this;
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/layers'));
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/keys'));
        this.roadObjects = [];
        // Copy original GeoJSON layers to dynamic layers
        var objectsFile = path.join(this.sourceFolder, 'road_objects.json');
        fs.readFile(objectsFile, function (err, data) {
            if (err) {
                Winston.error("Error reading " + objectsFile + ": " + err);
                return;
            }
            var ro = JSON.parse(data.toString());
            _this.roadObjectsLayer = _this.createNewLayer('roadobjects', 'Wegen', ro.features);
            _this.roadObjectsLayer.features.forEach(function (f) {
                if (!f.id)
                    f.id = csweb.newGuid();
                if (f.geometry.type !== 'LineString')
                    return;
                _this.setFeatureState(f, SimSvc.InfrastructureState.Ok);
                _this.roadObjects.push(f);
            });
            _this.publishLayer(_this.roadObjectsLayer);
        });
        this.fsm.currentState = SimSvc.SimState.Ready;
        this.sendAck(this.fsm.currentState);
    };
    /** Set the state and failure mode of a feature, optionally publishing it too. */
    RoadSim.prototype.setFeatureState = function (feature, state, failureMode, failureTime, publish) {
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
        this.updateFeature(this.roadObjectsLayer.id, feature, {}, function () { });
        // Publish PowerSupplyArea layer
        // if (state === SimSvc.InfrastructureState.Failed && feature.properties.hasOwnProperty('contour')) {
        //     var contour = new csweb.Feature();
        //     contour.id = csweb.newGuid();
        //     contour.properties = {
        //         name: 'Contour area',
        //         featureTypeId: 'AffectedArea'
        //     };
        //     contour.geometry = JSON.parse(feature.properties['contour']);
        //     this.addFeature(this.roadObjectsLayer.id, contour, <csweb.ApiMeta>{}, () => { });
        // }
    };
    RoadSim.prototype.getFeatureState = function (feature) {
        return feature.properties['state'];
    };
    RoadSim.prototype.createNewLayer = function (id, title, features, description) {
        var layer = {
            server: this.options.server,
            id: id,
            title: title,
            description: description,
            features: features,
            storage: 'file',
            enabled: true,
            isDynamic: true,
            typeUrl: this.options.server + "/api/resources/road",
            type: 'dynamicgeojson',
        };
        return layer;
    };
    /**
     * Create and publish the layer.
     */
    RoadSim.prototype.publishLayer = function (layer) {
        this.addUpdateLayer(layer, {}, function () { });
    };
    /**
     * pointInsidePolygon returns true if a 2D point lies within a polygon of 2D points
     * @param  {number[]}   point   [lat, lng]
     * @param  {number[][]} polygon [[lat, lng], [lat,lng],...]
     * @return {boolean}            Inside == true
     */
    RoadSim.prototype.pointInsidePolygon = function (point, polygon) {
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
     * lineInsideMultiPolygon returns true if a point of a 2D line lies within a multipolygon
     * @param  {number[][]}   line   [][lat, lng], ...]
     * @param  {number[][][]} polygon [[[lat, lng], [lat,lng]],...]]
     * @return {boolean}            Inside == true
     */
    RoadSim.prototype.lineInsidePolygon = function (line, polygon) {
        var _this = this;
        // https://github.com/substack/point-in-polygon
        // ray-casting algorithm based on
        // http://www.ecse.rpi.edu/Homepages/wrf/Research/Short_Notes/pnpoly.html
        var inside = line.some(function (l) { return (_this.pointInsidePolygon(l, polygon)); });
        return inside;
    };
    return RoadSim;
})(SimSvc.SimServiceManager);
exports.RoadSim = RoadSim;
//# sourceMappingURL=RoadSim.js.map