/*
    ***** BEGIN LICENSE BLOCK *****
	
	Copyright (c) 2011  Zotero
	                    Center for History and New Media
						George Mason University, Fairfax, Virginia, USA
						http://zotero.org
	
	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
	
	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU General Public License for more details.
	
	You should have received a copy of the GNU General Public License
	along with this program.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

var Zotero;

Comm = new function() {
	var _onlineObserverRegistered = false;
	var _converter, _lastDataListener;
	
	/**
	 * Observes browser startup to initialize ZoteroOpenOfficeIntegration HTTP server
	 */
	this.init = function() {
		Zotero = Components.classes["@zotero.org/Zotero;1"]
			.getService(Components.interfaces.nsISupports)
			.wrappedJSObject;
		
		if (Zotero.HTTP.browserIsOffline()) {
			Zotero.debug('ZoteroOpenOfficeIntegration: Browser is offline -- not initializing communication server');
			_registerOnlineObserver();
			return;
		}
		
		// initialize the converter
		_converter = Components.classes["@mozilla.org/intl/scriptableunicodeconverter"]
			.createInstance(Components.interfaces.nsIScriptableUnicodeConverter);
		_converter.charset = "UTF-8";
		
		// start listening on socket
		var serv = Components.classes["@mozilla.org/network/server-socket;1"]
					.createInstance(Components.interfaces.nsIServerSocket);
		try {
			// bind to a random port on loopback only
			serv.init(19876, true, -1);
			serv.asyncListen(SocketListener);
			
			Zotero.debug("ZoteroOpenOfficeIntegration: Communication server listening on 127.0.0.1:"+serv.port);
		} catch(e) {
			Zotero.debug("ZoteroOpenOfficeIntegration: Not initializing communication server");
		}

		_registerOnlineObserver()
	}
	
	/**
	 * Registers an observer to bring the server back online when Firefox comes online
	 */
	function _registerOnlineObserver() {
		if (_onlineObserverRegistered) return;
		
		// Observer to enable the integration when we go online
		var observer = function(subject, topic, data) {
			if (data == 'online') Comm.init();
		};
		
		var observerService =
			Components.classes["@mozilla.org/observer-service;1"]
				.getService(Components.interfaces.nsIObserverService);
		observerService.addObserver(observer, "network:offline-status-changed", false);
		
		_onlineObserverRegistered = true;
	}
	
	/**
	 * Accepts the socket and passes off to the DataListener
	 */
	var SocketListener = new function() {
		/**
		 * Called when a socket is opened
		 */
		this.onSocketAccepted = function(socket, transport) {
			Zotero.debug("ZoteroOpenOfficeIntegration: Connection received");
			new DataListener(transport);
		}
		
		this.onStopListening = function(serverSocket, status) {
			Zotero.debug("ZoteroOpenOfficeIntegration: Communication server going offline");
		}
	}
		
	/**
	 * Handles the actual acquisition of data
	 */
	var DataListener = function(transport) {
		this.rawiStream = transport.openInputStream(Components.interfaces.nsITransport.OPEN_BLOCKING, 0, 0);
		this.rawoStream = transport.openOutputStream(Components.interfaces.nsITransport.OPEN_BLOCKING, 0, 0);
		
		this._timerStarted = false;
		this._timer = Components.classes["@mozilla.org/timer;1"].
			createInstance(Components.interfaces.nsITimer);
		this._requestLength = null;
		
		this.iStream = Components.classes["@mozilla.org/binaryinputstream;1"].
			createInstance(Components.interfaces.nsIBinaryInputStream);
		this.iStream.setInputStream(this.rawiStream);
		
		this.oStream = Components.classes["@mozilla.org/binaryoutputstream;1"].
			createInstance(Components.interfaces.nsIBinaryOutputStream);
		this.oStream.setOutputStream(this.rawoStream);
		
		this.rawiStream.QueryInterface(Components.interfaces.nsIAsyncInputStream)
				.asyncWait(this, 0, 0, Zotero.mainThread);
	}
	
	DataListener.prototype = {
		"_requestLength":null,
		
		/**
		 * Called when a request begins (although the request should have begun before
		 * the DataListener was generated)
		 */
		"onStartRequest":function(request, context) {},
		
		/**
		 * Called when a request stops
		 */
		"onStopRequest":function(request, context, status) {
			this.iStream.close();
			this.oStream.close();
		},
	
		/**
		 * Called when new data is available. This is used for commands initiated by OOo. Responses
		 * to commands sent by Zotero are received synchronously as part of the sendCommand()
		 * function.
		 */
		//"onDataAvailable":function(request, context, inputStream, offset, count) {
		"onInputStreamReady":function(inputStream) {
			Zotero.debug("ZoteroOpenOfficeIntegration: Performing asynchronous read");
			if(this.rawiStream.available() == 0) return;
			
			// keep track of the last connection we read on
			_lastDataListener = this;
		
			// read data and forward to Zotero.Integration
			var payload = _receiveCommand(this.iStream);
			try {
				Zotero.Integration.execCommand("OpenOffice", payload, null);
			} catch(e) {
				Zotero.logError(e);
			}
			
			// do async waiting
			this.rawiStream.QueryInterface(Components.interfaces.nsIAsyncInputStream)
					.asyncWait(this, 0, 0, Zotero.mainThread);
		}
	}
	
	/**
	 * Reads from the communication channel. All commands consist of a 32 bit integer indicating the
	 * length of the payload, followed by a JSON payload.
	 */
	function _receiveCommand(iStream) {
		// read length int
		var requestLength = iStream.read32();
		Zotero.debug("ZoteroOpenOfficeIntegration: Reading "+requestLength+" bytes from stream");
		var input = iStream.readBytes(requestLength);
		
		// convert to readable format
		input = _converter.ConvertToUnicode(input);
		Zotero.debug("ZoteroOpenOfficeIntegration: Received "+input);
		return JSON.parse(input);
	}
	
	/**
	 * Writes to the communication channel.
	 */
	this.sendCommand = function(cmd, args) {
		var payload = JSON.stringify([cmd, args]);
		
		// write to stream
		Zotero.debug("ZoteroOpenOfficeIntegration: Sending "+payload);
		payload = _converter.ConvertFromUnicode(payload);
		_lastDataListener.oStream.write32(payload.length);
		_lastDataListener.oStream.writeBytes(payload, payload.length);
		
		var receivedData = _receiveCommand(_lastDataListener.iStream);
		
		return receivedData;
	}
}

/**
 * Loops through an "arguments" object, converting it to an array
 * @param {arguments} args
 * @param {Array} [initial] An array to append to the start
 * @return {Array} Arguments as an array
 */
function _cleanArguments(args, initial) {
	var out = (initial ? initial : []);
	for(var i=0; i<args.length; i++) {
		out.push(args[i]);
	}
	return out;
}

/**
 * A service to initialize the integration server on startup
 */
var Initializer = function() {
	Comm.init();
};
Initializer.prototype = {
	classDescription: "Zotero OpenOffice.org Integration Initializer",
	"classID":Components.ID("{f43193a1-7060-41a3-8e82-481d58b71e6f}"),
	"contractID":"@zotero.org/Zotero/integration/initializer?agent=OpenOffice;1",
	"QueryInterface":XPCOMUtils.generateQI([Components.interfaces.nsISupports]),
	"service":true
};

/**
 * See zoteroIntegration.idl
 */
var Application = function() {};
Application.prototype = {
	classDescription: "Zotero OpenOffice.org Integration Application",
	classID:		Components.ID("{8478cd98-5ba0-4848-925a-75adffff2dbf}"),
	contractID:		"@zotero.org/Zotero/integration/application?agent=OpenOffice;1",
	QueryInterface: XPCOMUtils.generateQI([Components.interfaces.nsISupports, Components.interfaces.zoteroIntegrationApplication]),
	_xpcom_categories: [{
		category: "profile-after-change",
		service: true
	}],
	"service":		true,
	"getActiveDocument":function() {
		Comm.sendCommand("Application_getActiveDocument", []);
		return new Document();
	},
	"primaryFieldType":"ReferenceMark",
	"secondaryFieldType":"Bookmark"
};

/**
 * See zoteroIntegration.idl
 */
var Document = function() {};
Document.prototype = {
	classDescription: "Zotero OpenOffice.org Integration Document",
	classID:		Components.ID("{e2e05bf9-40d4-4426-b0c9-62abca5be58f}"),
	contractID:		"@zotero.org/Zotero/integration/document?agent=OpenOffice;1",
	QueryInterface: XPCOMUtils.generateQI([Components.interfaces.nsISupports, Components.interfaces.zoteroIntegrationDocument])
};
for each(var method in ["displayAlert", "activate", "canInsertField", "getDocumentData",
	"setDocumentData", "setBibliographyStyle", "cleanup"]) {
	let methodStable = method;
	Document.prototype[method] = function() Comm.sendCommand("Document_"+methodStable, _cleanArguments(arguments));
}
Document.prototype.cursorInField = function() {
	var retVal = Comm.sendCommand("Document_cursorInField", _cleanArguments(arguments));
	if(retVal === null) return null;
	return new Field(retVal);
};
Document.prototype.insertField = function() {
	var retVal = Comm.sendCommand("Document_insertField", _cleanArguments(arguments));
	return new Field(retVal);
};
Document.prototype.getFields = function() {
	var retVal = Comm.sendCommand("Document_getFields", _cleanArguments(arguments));
	return new FieldEnumerator(retVal);
};
Document.prototype.convert = function(enumerator, fieldType, noteTypes) {
	var i = 0;
	while(enumerator.hasMoreElements()) {
		Comm.sendCommand("Field_convert", [enumerator.getNext()._num, fieldType, noteTypes[i]]);
		i++;
	}
};

/**
 * An enumerator implementation to handle passing off fields
 */
var FieldEnumerator = function(range) {
	this._curField = range[0];
	this._maxField = range[1];
};
FieldEnumerator.prototype = {
	"hasMoreElements":function() {
		return !(this._curField > this._maxField);
	}, 
	"getNext":function() {
		if(this._curField > this._maxField) throw "No more fields!";
		return new Field(this._curField++);
	},
	QueryInterface: XPCOMUtils.generateQI([Components.interfaces.nsISupports, Components.interfaces.nsISimpleEnumerator])
};

/**
 * See zoteroIntegration.idl
 */
var Field = function(num) {
	this._num = num;
	this.wrappedJSObject = this;
};
Field.prototype = {
	classDescription: "Zotero OpenOffice.org Integration Field",
	classID:		Components.ID("{82483c48-304c-460e-ab31-fac872f20379}"),
	contractID:		"@zotero.org/Zotero/integration/field?agent=OpenOffice;1",
	QueryInterface: XPCOMUtils.generateQI([Components.interfaces.nsISupports, Components.interfaces.zoteroIntegrationField])
};
for each(var method in ["delete", "select", "removeCode", "setText", "getCode", "setCode",
	"getNoteIndex"]) {
	let methodStable = method;
	Field.prototype[method] = function() Comm.sendCommand("Field_"+methodStable, _cleanArguments(arguments, [this._num]));
}
Field.prototype.equals = function(arg) {
	if(this._num === arg.wrappedJSObject._num) return true;
	return Comm.sendCommand("Field_equals", [this._num, arg.wrappedJSObject._num]);
}

var classes = [
	Initializer,
	Application,
	Field,
	Document
];

/**
* XPCOMUtils.generateNSGetFactory was introduced in Mozilla 2 (Firefox 4).
* XPCOMUtils.generateNSGetModule is for Mozilla 1.9.2 (Firefox 3.6).
*/
if(XPCOMUtils.generateNSGetFactory) {
	var NSGetFactory = XPCOMUtils.generateNSGetFactory(classes);
} else {
	var NSGetModule = XPCOMUtils.generateNSGetModule(classes);
}
