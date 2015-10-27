'use strict';

/*global require*/
var URI = require('urijs');

var clone = require('terriajs-cesium/Source/Core/clone');
var defined = require('terriajs-cesium/Source/Core/defined');
var definedNotNull = require('terriajs-cesium/Source/Core/definedNotNull');
var defineProperties = require('terriajs-cesium/Source/Core/defineProperties');
var freezeObject = require('terriajs-cesium/Source/Core/freezeObject');
var knockout = require('terriajs-cesium/Source/ThirdParty/knockout');
var loadJson = require('terriajs-cesium/Source/Core/loadJson');

var ModelError = require('./ModelError');
var CatalogGroup = require('./CatalogGroup');
var GeoJsonCatalogItem = require('./GeoJsonCatalogItem');
var inherit = require('../Core/inherit');

/**
 * A {@link CatalogGroup} representing a collection of individual features from a Web Feature
 * Service (WFS) server.
 *
 * @alias WfsFeaturesCatalogGroup
 * @constructor
 * @extends CatalogGroup
 *
 * @param {Terria} terria The Terria instance.
 */
var WfsFeaturesCatalogGroup = function(terria) {
    CatalogGroup.call(this, terria, 'wfs-getCapabilities');

    /**
     * Gets or sets the URL of the WFS server.  This property is observable.
     * @type {String}
     */
    this.url = '';

    /**
     * Gets or sets the WFS feature type names.
     * @type {String}
     */
    this.typeNames = '';

    /**
     * Gets or sets the name of property from which to derive the names of the catalog items in this group.
     * This property is observable.
     * @type {String}
     */
    this.nameProperty = undefined;

    /**
     * Gets or sets the name of the property by which to group the catalog items in this group.  If this property
     * is undefined, all catalog items are added at the top level.  This property is observable.
     * @type {String}
     */
    this.groupByProperty = undefined;

    /**
     * Gets or sets a description of the custodian of the data sources in this group.
     * This property is an HTML string that must be sanitized before display to the user.
     * This property is observable.
     * @type {String}
     */
    this.dataCustodian = undefined;

    /**
     * Gets or sets a hash of names of blacklisted data layers.  A layer that appears in this hash
     * will not be shown to the user.  In this hash, the keys should be the Title of the layers to blacklist,
     * and the values should be "true".  This property is observable.
     * @type {Object}
     */
    this.blacklist = undefined;

    /**
     * Gets or sets a hash of properties that will be set on each child item.
     * For example, { 'treat404AsError': false }
     */
    this.itemProperties = undefined;

    knockout.track(this, ['url', 'typeNames', 'nameProperty', 'groupByProperty', 'dataCustodian', 'blacklist']);
};

inherit(CatalogGroup, WfsFeaturesCatalogGroup);

defineProperties(WfsFeaturesCatalogGroup.prototype, {
    /**
     * Gets the type of data member represented by this instance.
     * @memberOf WfsFeaturesCatalogGroup.prototype
     * @type {String}
     */
    type : {
        get : function() {
            return 'wfs-features-group';
        }
    },

    /**
     * Gets a human-readable name for this type of data source, such as 'Group of features in a Web Feature Service (WFS) Server'.
     * @memberOf WfsFeaturesCatalogGroup.prototype
     * @type {String}
     */
    typeName : {
        get : function() {
            return 'Group of features in a Web Feature Service (WFS) Server';
        }
    },

    /**
     * Gets the set of functions used to serialize individual properties in {@link CatalogMember#serializeToJson}.
     * When a property name on the model matches the name of a property in the serializers object lieral,
     * the value will be called as a function and passed a reference to the model, a reference to the destination
     * JSON object literal, and the name of the property.
     * @memberOf WfsFeaturesCatalogGroup.prototype
     * @type {Object}
     */
    serializers : {
        get : function() {
            return WfsFeaturesCatalogGroup.defaultSerializers;
        }
    }
});

/**
 * Gets or sets the set of default serializer functions to use in {@link CatalogMember#serializeToJson}.  Types derived from this type
 * should expose this instance - cloned and modified if necesary - through their {@link CatalogMember#serializers} property.
 * @type {Object}
 */
WfsFeaturesCatalogGroup.defaultSerializers = clone(CatalogGroup.defaultSerializers);

WfsFeaturesCatalogGroup.defaultSerializers.items = function(wfsGroup, json, propertyName, options) {
    // Only serialize minimal properties in contained items, because other properties are loaded from GetCapabilities.
    var previousSerializeForSharing = options.serializeForSharing;
    options.serializeForSharing = true;

    // Only serlize enabled items as well.  This isn't quite right - ideally we'd serialize any
    // property of any item if the property's value is changed from what was loaded from GetCapabilities -
    // but this gives us reasonable results for sharing and is a lot less work than the ideal
    // solution.
    var previousEnabledItemsOnly = options.enabledItemsOnly;
    options.enabledItemsOnly = true;

    CatalogGroup.defaultSerializers.items(wfsGroup, json, propertyName, options);

    options.enabledItemsOnly = previousEnabledItemsOnly;
    options.serializeForSharing = previousSerializeForSharing;
};

WfsFeaturesCatalogGroup.defaultSerializers.isLoading = function(wfsGroup, json, propertyName, options) {};

freezeObject(WfsFeaturesCatalogGroup.defaultSerializers);

WfsFeaturesCatalogGroup.prototype._getValuesThatInfluenceLoad = function() {
    return [this.url, this.typeNames, this.nameProperty, this.groupByProperty, this.blacklist];
};

WfsFeaturesCatalogGroup.prototype._load = function() {
    var url = cleanAndProxyUrl(this.terria, this.url) + '?service=WFS&version=1.1.0&request=GetFeature&typeName=' + encodeURIComponent(this.typeNames) +
              '&outputFormat=JSON&propertyName=' + encodeURIComponent(this.nameProperty);
    if (defined(this.groupByProperty)) {
        url += ',' + encodeURIComponent(this.groupByProperty);
    }

    var that = this;
    return loadJson(url).then(function(json) {
        // Is this really a GetCapabilities response?
        if (!json || json.type !== 'FeatureCollection' || !definedNotNull(json.features)) {
            throw new ModelError({
                title: 'Error querying WFS server',
                message: '\
An error occurred while invoking GetFeature on the WFS server.  The server\'s response does not appear to be a valid GeoJSON document.  \
<p>If you entered the link manually, please verify that the link is correct.</p>\
<p>If you did not enter this link manually, this error may indicate that the group you opened is temporarily unavailable or there is a \
problem with your internet connection.  Try opening the group again, and if the problem persists, please report it by \
sending an email to <a href="mailto:'+that.terria.supportEmail+'">'+that.terria.supportEmail+'</a>.</p>'
            });
        }

        var groups = {};

        var features = json.features;
        for (var i = 0; i < features.length; ++i) {
            var feature = features[i];

            var name = feature.properties[that.nameProperty];

            if (that.blacklist && that.blacklist[name]) {
                console.log('Provider Feedback: Filtering out ' + name + ' (' + feature.id + ') because it is blacklisted.');
                continue;
            }

            var item = new GeoJsonCatalogItem(that.terria);
            item.name = name;
            item.url = cleanUrl(that.url) + '?service=WFS&version=1.1.0&request=GetFeature&typeName=' + encodeURIComponent(that.typeNames) +
                       '&featureID=' + encodeURIComponent(feature.id) + '&outputFormat=JSON';

            if (typeof(that.itemProperties) === 'object') {
                item.updateFromJson(that.itemProperties);
            }

            var group = that;
            if (defined(that.groupByProperty) && definedNotNull(feature.properties[that.groupByProperty])) {
                group = groups[feature.properties[that.groupByProperty]];
                if (!defined(group)) {
                    group = groups[feature.properties[that.groupByProperty]] = new CatalogGroup(that.terria);
                    group.name = feature.properties[that.groupByProperty];
                    that.items.push(group);
                }
            }
            group.items.push(item);
        }
    }).otherwise(function(e) {
        throw new ModelError({
            title: 'Group is not available',
            message: '\
An error occurred while invoking GetFeature on the WFS server.  \
<p>If you entered the link manually, please verify that the link is correct.</p>\
<p>This error may also indicate that the server does not support <a href="http://enable-cors.org/" target="_blank">CORS</a>.  If this is your \
server, verify that CORS is enabled and enable it if it is not.  If you do not control the server, \
please contact the administrator of the server and ask them to enable CORS.  Or, contact the '+that.terria.appName+' \
Map team by emailing <a href="mailto:'+that.terria.supportEmail+'">'+that.terria.supportEmail+'</a> \
and ask us to add this server to the list of non-CORS-supporting servers that may be proxied by '+that.terria.appName+' \
itself.</p>\
<p>If you did not enter this link manually, this error may indicate that the group you opened is temporarily unavailable or there is a \
problem with your internet connection.  Try opening the group again, and if the problem persists, please report it by \
sending an email to <a href="mailto:'+that.terria.supportEmail+'">'+that.terria.supportEmail+'</a>.</p>'
        });
    });
};

function cleanUrl(url) {
    // Strip off the search portion of the URL
    var uri = new URI(url);
    uri.search('');
    return uri.toString();
}

function cleanAndProxyUrl(terria, url) {
    var cleanedUrl = cleanUrl(url);
    if (defined(terria.corsProxy) && terria.corsProxy.shouldUseProxy(cleanedUrl)) {
        cleanedUrl = terria.corsProxy.getURL(cleanedUrl, '1d');
    }

    return cleanedUrl;
}

module.exports = WfsFeaturesCatalogGroup;