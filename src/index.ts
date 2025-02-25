#!/usr/bin/env node

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

/**
 * This is a FHIR MCP server implementation that provides access to FHIR resources.
 * It supports:
 * - Reading FHIR resources
 * - Searching FHIR resources
 * - Retrieving CapabilityStatement
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ReadResourceRequest,
  CallToolRequest,
  ReadResourceResult,
  CallToolResult
} from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';

interface FHIRConfig {
  baseUrl: string;
  accessToken: string;
}

const config: FHIRConfig = {
  baseUrl: process.env.FHIR_BASE_URL || '',
  accessToken: process.env.FHIR_ACCESS_TOKEN || '',
};

// FHIR client setup
const fhirClient = axios.create({
  baseURL: config.baseUrl,
  headers: {
    'Authorization': `Bearer ${config.accessToken}`,
    'Content-Type': 'application/fhir+json',
    'Accept': 'application/fhir+json',
  },
});

// Add type for capability statement
interface FHIRCapabilityStatement {
  rest: Array<{
    resource: Array<{
      type: string;
      // Add other relevant fields
    }>;
  }>;
}

let capabilityStatement: FHIRCapabilityStatement | null = null;

interface TimeSlot {
  id: string;
  start: string;
  end: string;
  status: 'free' | 'busy';
}

function processAvailableSlots(
  scheduleBundle: any,
  appointmentBundle: any,
  duration: number
): TimeSlot[] {
  const slots: TimeSlot[] = [];
  
  // Process schedule to get available slots
  if (scheduleBundle.entry) {
    scheduleBundle.entry.forEach((entry: any) => {
      const schedule = entry.resource;
      if (schedule.planningHorizon) {
        const start = new Date(schedule.planningHorizon.start);
        const end = new Date(schedule.planningHorizon.end);
        
        // Create slots based on duration
        let currentSlot = new Date(start);
        while (currentSlot < end) {
          const slotEnd = new Date(currentSlot.getTime() + duration * 60000);
          slots.push({
            id: `${currentSlot.toISOString()}-${slotEnd.toISOString()}`,
            start: currentSlot.toISOString(),
            end: slotEnd.toISOString(),
            status: 'free'
          });
          currentSlot = slotEnd;
        }
      }
    });
  }

  // Mark slots as busy based on existing appointments
  if (appointmentBundle.entry) {
    appointmentBundle.entry.forEach((entry: any) => {
      const appointment = entry.resource;
      const appointmentStart = new Date(appointment.start);
      const appointmentEnd = new Date(appointment.end);

      slots.forEach(slot => {
        const slotStart = new Date(slot.start);
        const slotEnd = new Date(slot.end);

        // Check for overlap
        if (
          (appointmentStart >= slotStart && appointmentStart < slotEnd) ||
          (appointmentEnd > slotStart && appointmentEnd <= slotEnd) ||
          (appointmentStart <= slotStart && appointmentEnd >= slotEnd)
        ) {
          slot.status = 'busy';
        }
      });
    });
  }

  // Return only free slots
  return slots.filter(slot => slot.status === 'free');
}

const server = new Server(
  {
    name: "@flexpa/mpc-fhir",
    version: "0.0.1",
  },
  {
    capabilities: {
      resources: {},
      tools: {}
    }
  }
);

// Cache capability statement
async function getCapabilityStatement() {
  if (!capabilityStatement) {
    const response = await fhirClient.get('/metadata');
    capabilityStatement = response.data;
  }
  return capabilityStatement;
}

/**
 * Handler for listing available FHIR resources based on CapabilityStatement
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const capability = await getCapabilityStatement();
  const resources = capability?.rest[0].resource || [];
  
  return {
    resources: resources.map((resource: any) => ({
      uri: `fhir://${resource.type}`,
      mimeType: "application/fhir+json",
      name: resource.type,
      description: `FHIR ${resource.type} resource`
    }))
  };
});

/**
 * Handler for reading FHIR resources
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request: ReadResourceRequest): Promise<ReadResourceResult> => {
  const url = new URL(request.params.uri);
  const resourceType = url.hostname;
  const id = url.pathname.replace(/^\//, '');

  try {
    const response = await fhirClient.get(`/${resourceType}/${id}`);
    
    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "application/fhir+json",
        text: JSON.stringify(response.data, null, 2)
      }]
    };
  } catch (error: any) {
    throw new Error(`Failed to fetch FHIR resource: ${error.message}`);
  }
});

/**
 * Handler that lists available tools for FHIR operations
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "find_available_slots",
        description: "Find available appointment slots based on constraints",
        inputSchema: {
          type: "object",
          properties: {
            practitionerId: {
              type: "string",
              description: "ID of the healthcare provider"
            },
            appointmentType: {
              type: "string",
              description: "Type of appointment (e.g., followup, initial, procedure)"
            },
            duration: {
              type: "integer",
              description: "Duration in minutes"
            },
            startDate: {
              type: "string",
              description: "Start date for search range (ISO format)"
            },
            endDate: {
              type: "string",
              description: "End date for search range (ISO format)"
            }
          },
          required: ["practitionerId", "duration", "startDate", "endDate"],
          additionalProperties: false
        },
        outputSchema: {
          type: "object",
          properties: {
            availableSlots: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  start: { type: "string" },
                  end: { type: "string" }
                }
              }
            }
          }
        }
      },
      {
        name: "schedule_appointment",
        description: "Schedule a new appointment",
        inputSchema: {
          type: "object",
          properties: {
            patientId: {
              type: "string",
              description: "FHIR Patient resource ID"
            },
            practitionerId: {
              type: "string",
              description: "FHIR Practitioner resource ID"
            },
            appointmentType: {
              type: "string",
              description: "Type of appointment"
            },
            startTime: {
              type: "string",
              description: "Start time of the appointment (ISO format)"
            },
            endTime: {
              type: "string",
              description: "End time of the appointment (ISO format)"
            },
            notes: {
              type: "string",
              description: "Notes about the appointment"
            }
          },
          required: ["patientId", "practitionerId", "appointmentType", "startTime", "endTime"],
          additionalProperties: false
        },
        outputSchema: {
          type: "object",
          properties: {
            appointment: {
              type: "object",
              description: "The created FHIR Appointment resource"
            }
          }
        }
      },
      {
        name: "update_fhir",
        description: "Update a FHIR resource",
        inputSchema: {
          type: "object",
          properties: {
            resourceType: {
              type: "string",
              description: "Type of FHIR resource to update"
            },
            id: {
              type: "string",
              description: "ID of the FHIR resource to update"
            },
            resource: {
              type: "object",
              description: "Updated FHIR resource data"
            }
          },
          required: ["resourceType", "id", "resource"]
        }
      },
      {
        name: "search_fhir",
        description: "Search FHIR resources",
        inputSchema: {
          type: "object",
          properties: {
            resourceType: {
              type: "string",
              description: "Type of FHIR resource to search"
            },
            searchParams: {
              type: "object",
              description: "Search parameters"
            }
          },
          required: ["resourceType"]
        }
      },
      {
        name: "read_fhir",
        description: "Read an individual FHIR resource",
        inputSchema: {
          type: "object",
          properties: {
            uri: {
              type: "string",
              description: "URI of the FHIR resource to read"
            }
          },
          required: ["uri"]
        }
      }
    ]
  };
});

/**
 * Handler for FHIR operations
 */
server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
  switch (request.params.name) {
    case "find_available_slots": {
      const { practitionerId, appointmentType, duration, startDate, endDate } = request.params.arguments || {};
      
      try {
        // Get practitioner's schedule
        const scheduleResponse = await fhirClient.get('/Schedule', {
          params: {
            actor: practitionerId,
            date: `ge${startDate}&le${endDate}`
          }
        });

        // Get existing appointments
        const appointmentsResponse = await fhirClient.get('/Appointment', {
          params: {
            practitioner: practitionerId,
            date: `ge${startDate}&le${endDate}`
          }
        });

        // Process schedules and appointments to find available slots
        const durationInMinutes = typeof duration === 'number' ? duration : parseInt(String(duration));
        if (isNaN(durationInMinutes)) {
          throw new Error('Duration must be a valid number');
        }

        const availableSlots = processAvailableSlots(
          scheduleResponse.data,
          appointmentsResponse.data,
          durationInMinutes
        );

        return {
          content: [{
            type: "text",
            text: JSON.stringify(availableSlots, null, 2)
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to find available slots: ${error.message}`);
      }
    }

    case "schedule_appointment": {
      const {
        patientId,
        practitionerId,
        appointmentType,
        startTime,
        endTime,
        notes
      } = request.params.arguments || {};

      try {
        // Create FHIR Appointment resource
        const appointmentResource = {
          resourceType: "Appointment",
          status: "booked",
          appointmentType: {
            coding: [{
              system: "http://terminology.hl7.org/CodeSystem/appointment-type",
              code: appointmentType
            }]
          },
          start: startTime,
          end: endTime,
          participant: [
            {
              actor: {
                reference: `Patient/${patientId}`
              },
              status: "accepted"
            },
            {
              actor: {
                reference: `Practitioner/${practitionerId}`
              },
              status: "accepted"
            }
          ],
          comment: notes
        };

        const response = await fhirClient.post('/Appointment', appointmentResource);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(response.data, null, 2)
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to schedule appointment: ${error.message}`);
      }
    }

    case "update_fhir": {
      const resourceType = String(request.params.arguments?.resourceType);
      const id = String(request.params.arguments?.id);
      const resource = request.params.arguments?.resource;

      if (!resource) {
        throw new Error('Resource data is required for update');
      }

      try {
        const response = await fhirClient.put(`/${resourceType}/${id}`, resource);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response.data, null, 2)
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to update FHIR resource: ${error.message}`);
      }
    }

    case "search_fhir": {
      const resourceType = String(request.params.arguments?.resourceType);
      const searchParams = request.params.arguments?.searchParams || {};

      try {
        const response = await fhirClient.get(`/${resourceType}`, { params: searchParams });
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response.data, null, 2)
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to search FHIR resources: ${error.message}`);
      }
    }

    case "read_fhir": {
      const uri = String(request.params.arguments?.uri);
      const url = new URL(uri);
      const resourceType = url.hostname;
      const id = url.pathname.replace(/^\//, '');

      try {
        const response = await fhirClient.get(`/${resourceType}/${id}`);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response.data, null, 2)
          }]
        };
      } catch (error: any) {
        throw new Error(`Failed to fetch FHIR resource: ${error.message}`);
      }
    }

    default:
      throw new Error("Unknown tool");
  }
});

async function main() {
  if (!config.baseUrl || !config.accessToken) {
    throw new Error('FHIR_BASE_URL and FHIR_ACCESS_TOKEN environment variables must be set');
  }
  
  // Validate FHIR server connection by fetching capability statement
  await getCapabilityStatement();
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
