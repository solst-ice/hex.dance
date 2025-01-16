import React, { useState } from 'react'

// Function descriptions for common functions
const functionDescriptions = {
  printf: "Prints formatted text to stdout. Part of stdio.h",
  fprintf: "Prints formatted text to a specified file stream. Part of stdio.h",
  putchar: "Writes a single character to stdout. Part of stdio.h",
  puts: "Writes a string and a newline to stdout. Part of stdio.h",
  free: "Deallocates memory previously allocated by malloc/calloc. Part of stdlib.h",
  malloc: "Allocates memory dynamically. Part of stdlib.h",
  realloc: "Reallocates memory block to new size. Part of stdlib.h",
  exit: "Terminates the calling process. Part of stdlib.h",
  fputs: "Writes a string to a file stream. Part of stdio.h",
  fwrite: "Writes binary data to a file stream. Part of stdio.h",
  strchr: "Locates first occurrence of character in string. Part of string.h",
  strdup: "Creates a duplicate of a string. Part of string.h",
  '__stack_chk_fail': "Stack protector failure handler",
  '__stack_chk_guard': "Stack protector guard value",
  '__stderrp': "Standard error stream pointer",
  'select$DARWIN_EXTSN': "BSD socket select operation (Darwin extension)",
  'ares_destroy': "Destroys a c-ares channel",
  'ares_fds': "Gets c-ares file descriptors",
  'ares_freeaddrinfo': "Frees address info structure",
  'ares_getaddrinfo': "Performs asynchronous DNS resolution",
  'ares_gethostbyaddr': "Performs reverse DNS lookup",
  'ares_inet_ntop': "Converts IP address to string",
  'ares_inet_pton': "Converts string to IP address",
  'ares_init_options': "Initializes c-ares library with options",
  'ares_library_cleanup': "Cleans up c-ares library",
  'ares_library_init': "Initializes c-ares library",
  'ares_process': "Processes c-ares callbacks",
  'ares_set_servers_csv': "Sets DNS servers from CSV string",
  'ares_strcaseeq': "Case-insensitive string comparison",
  'ares_strerror': "Gets error string for c-ares error code",
  'ares_timeout': "Gets c-ares timeout value"
}

function FunctionItem({ func, isSelected, onSelect, isExpanded, isMetadata }) {
  if (isMetadata) {
    const [label, ...valueParts] = func.split(': ')
    const value = valueParts.join(': ') // Rejoin in case value contains colons
    return (
      <div className="metadata-item">
        <span className="metadata-label">{label}</span>
        <span className="metadata-value">
          {value && value.includes('\n') 
            ? value.split('\n').map((line, i) => (
                <div key={i} className="tree-line" style={{fontFamily: 'monospace'}}>
                  {line}
                </div>
              ))
            : value
          }
        </span>
      </div>
    )
  }

  // Handle Mach-O symbols
  const name = func.slice(0, -4)  // Remove the (T) or (U) suffix
  const type = func.slice(-2, -1) // Get T or U

  return (
    <div className="function-item">
      <li 
        onClick={onSelect}
        className={isSelected || isExpanded ? 'selected' : ''}
      >
        {name} <span className="symbol-type">({type})</span>
      </li>
      <div 
        className={`function-description inline ${isSelected || isExpanded ? 'show' : ''}`}
      >
        {functionDescriptions[name] || "No description available for this function."}
      </div>
    </div>
  )
}

function FunctionList({ functions, title = 'Found Symbols' }) {
  const [selectedFunction, setSelectedFunction] = useState(null)
  const [expandAll, setExpandAll] = useState(false)
  const isMetadata = title === 'File Metadata'

  // Check if we have any functions using Set.size
  const hasFunctions = functions instanceof Set && functions.size > 0

  if (!hasFunctions) return null

  const sortMetadataFields = (items) => {
    const order = ['Width', 'Height']; // Priority order
    return [...items].sort((a, b) => {
      const aLabel = a.split(':')[0].trim();
      const bLabel = b.split(':')[0].trim();
      
      // Get indices from order array, -1 if not found
      const aIndex = order.indexOf(aLabel);
      const bIndex = order.indexOf(bLabel);
      
      // If both items are in order array, sort by their position
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      // If only a is in order array, it comes first
      if (aIndex !== -1) return -1;
      // If only b is in order array, it comes first
      if (bIndex !== -1) return 1;
      // Otherwise, sort alphabetically
      return aLabel.localeCompare(bLabel);
    });
  };

  return (
    <div className={`function-list ${isMetadata ? 'metadata-grid' : ''}`}>
      <div className="function-list-header">
        <h2>{isMetadata ? 'METADATA' : title}</h2>
        {!isMetadata && (
          <button 
            className="expand-toggle" 
            onClick={() => setExpandAll(!expandAll)}
          >
            {expandAll ? 'Collapse All' : 'Expand All'}
          </button>
        )}
      </div>
      {isMetadata ? (
        <div className="metadata-grid">
          {sortMetadataFields([...functions]).map((func, index) => (
            <FunctionItem 
              key={index} 
              func={func} 
              isMetadata={true}
            />
          ))}
        </div>
      ) : (
        <ul>
          {[...functions].sort().map((func, index) => (
            <FunctionItem 
              key={index} 
              func={func} 
              isSelected={selectedFunction === func}
              onSelect={() => setSelectedFunction(func === selectedFunction ? null : func)}
              isExpanded={expandAll}
              isMetadata={false}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

export default FunctionList 