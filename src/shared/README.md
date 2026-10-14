# src/shared — types shared by all processes

IPC contracts, settings schemas, ProblemRecord, small utilities. Must not import Electron, Node-only or DOM-only
modules unless the file says which process it is for.
