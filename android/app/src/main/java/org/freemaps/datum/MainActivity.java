package org.freemaps.datum;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(DocumentPickerPlugin.class);
        registerPlugin(CompassSensorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
